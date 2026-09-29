/**
 * 会话层自检。
 *
 * 这一层用了「扁平镜像 + 切会话时提交」的结构:顶层那些扁平字段是**当前会话的
 * 活工作集**,`sessions` 里是已经提交下来的快照。两种表示之间只有四个转换点
 * (切换、新建、落盘、载入),所以风险集中在两点:
 *
 *   · **切会话时忘了提交** → 直接丢掉一整块工作
 *   · **切会话时没清干净** → 会话之间互相串
 *
 * 两条都不体现在正常路径上(单会话永远是对的),只能专门测。
 * 运行:npm run check:store
 */
import { blankSession, useSession } from '../src/store/session';
import type { ChatMessage } from '../src/store/session';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const store = () => useSession.getState();
const msgs = () => store().messages;

function waitHydrated(): Promise<void> {
  if (store().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useSession.subscribe((s) => {
      if (s.hydrated) {
        unsub();
        resolve();
      }
    });
  });
}

/** 一个干净的基线:两个空会话,活工作集指向 A。 */
function resetStore() {
  const a = blankSession('sess-a', '会话 A');
  const b = blankSession('sess-b', '会话 B');
  useSession.setState({
    sessions: { 'sess-a': a, 'sess-b': b },
    activeSessionId: 'sess-a',
    hydrated: true,
    artifacts: [],
    runtime: {},
    interactions: {},
    messages: [],
    apiHistory: [],
    pendingEvents: [],
    focusId: undefined,
    busy: false,
    status: null,
  });
}

const PLOT = {
  kind: 'plot2d' as const,
  view: { x: [0, 1] as [number, number] },
  curves: [{ type: 'explicit' as const, expr: 'x' }],
};

async function main() {
  await waitHydrated();

  console.log('\n切会话时的提交 —— 漏一步就丢一块工作');

  {
    resetStore();
    store().addArtifact(PLOT, 'y = x', 'ai');
    ok('在 A 里建了东西', store().artifacts.length === 1);

    store().switchSession('sess-b');
    ok('切到 B 之后画布是空的', store().artifacts.length === 0, String(store().artifacts.length));

    store().switchSession('sess-a');
    ok('切回 A,东西还在', store().artifacts.length === 1, String(store().artifacts.length));
    ok('而且就是原来那个', store().artifacts[0]?.title === 'y = x', store().artifacts[0]?.title);
  }

  {
    resetStore();
    store().pushMessage({ role: 'user', content: 'A 的问题' });
    store().switchSession('sess-b');
    ok('B 看不到 A 的消息', msgs().length === 0, String(msgs().length));

    store().pushMessage({ role: 'user', content: 'B 的问题' });
    store().switchSession('sess-a');
    ok('切回 A 看到的是自己的消息', msgs()[0]?.content === 'A 的问题', msgs()[0]?.content);
    ok('A 里没有被塞进 B 的消息', msgs().length === 1, String(msgs().length));
  }

  {
    // 易失字段不能跨会话携带:apiHistory 里有工具调用细节,
    // 带过去会让新会话看到不相干的工具结果
    resetStore();
    store().pushApi({ role: 'user', content: '发给模型的东西' });
    store().pushEvent({ type: 'paramChange', artifactId: 'x', param: 'a', value: 1 });
    store().switchSession('sess-b');
    ok('apiHistory 不跨会话', store().apiHistory.length === 0, String(store().apiHistory.length));
    ok('pendingEvents 不跨会话', store().pendingEvents.length === 0, String(store().pendingEvents.length));
    ok('focusId 不跨会话', store().focusId === undefined);
  }

  console.log('\n思维链不进会话快照');

  {
    resetStore();
    store().pushMessage({ role: 'assistant', content: '正文', reasoning: '一段很长的思考' } as ChatMessage);
    store().commitActive();
    const rec = store().sessions['sess-a'];
    ok('快照里剥掉了思维链', rec.messages[0]?.reasoning === undefined, JSON.stringify(rec.messages[0]));
    ok('活工作集里仍然保留(界面还要显示它)', msgs()[0]?.reasoning === '一段很长的思考');
    ok('正文没有被动', rec.messages[0]?.content === '正文');
  }

  console.log('\nactiveSessionId 悬空时的回退');

  {
    resetStore();
    useSession.setState({ activeSessionId: '根本不存在的会话' });
    store().finishHydration('memory');
    ok('挪到一个存在的会话上', !!store().sessions[store().activeSessionId], store().activeSessionId);
  }

  {
    // 存档损坏 / 半写入之后可能一个会话都没有,不能就这么停在悬空状态
    resetStore();
    useSession.setState({ sessions: {}, activeSessionId: '空' });
    store().finishHydration('memory');
    ok('一个会话都没有时自动建一个', !!store().sessions[store().activeSessionId], store().activeSessionId);
  }

  console.log('\n删除与归档');

  {
    resetStore();
    useSession.setState({ activeSessionId: 'sess-b' });
    store().deleteSession('sess-b');
    ok('删掉的是记录本身', store().sessions['sess-b'] === undefined);
    ok('active 挪到了别的会话', store().activeSessionId === 'sess-a', store().activeSessionId);
  }

  {
    resetStore();
    store().archiveSession('sess-a'); // 归档的正好是当前会话
    ok('归档后 active 挪走,不停在收起的上面', store().activeSessionId === 'sess-b', store().activeSessionId);
    ok('但内容仍然保留', store().sessions['sess-a'] !== undefined);
    ok('标记为已归档', store().sessions['sess-a'].archived === true);
  }

  {
    resetStore();
    store().unarchiveSession('sess-a');
    store().archiveSession('sess-a');
    useSession.setState({ activeSessionId: 'sess-a' });
    store().deleteSession('sess-a');
    store().deleteSession('sess-b');
    ok('会话删光之后自动建一个新的', Object.keys(store().sessions).length === 1, JSON.stringify(Object.keys(store().sessions)));
    ok('并且 active 指向它', !!store().sessions[store().activeSessionId]);
  }

  console.log('\n新建会话');

  {
    resetStore();
    store().addArtifact(PLOT, 'y = x', 'ai');
    store().newSession();
    ok('新会话是空的画布', store().artifacts.length === 0, String(store().artifacts.length));
    ok('旧会话被保留了', Object.keys(store().sessions).length === 3, String(Object.keys(store().sessions).length));
    store().switchSession('sess-a');
    ok('切回去东西还在', store().artifacts.length === 1);
  }

  console.log('\n重命名');

  {
    resetStore();
    store().renameSession('sess-a', '  极限的定义  ');
    ok('两端空白被去掉', store().sessions['sess-a'].title === '极限的定义', store().sessions['sess-a'].title);
    store().renameSession('sess-a', '   ');
    ok('空标题被忽略,不会把名字弄没', store().sessions['sess-a'].title === '极限的定义');
  }

  console.log('\n清空对话只清当前会话的对话');

  {
    resetStore();
    store().addArtifact(PLOT, 'y = x', 'ai');
    store().pushMessage({ role: 'user', content: '问题' });
    store().pushApi({ role: 'user', content: '给模型的' });
    store().clearConversation();
    ok('消息清空了', msgs().length === 0);
    ok('给模型的历史也清空了', store().apiHistory.length === 0);
    ok('画布不受影响', store().artifacts.length === 1, String(store().artifacts.length));
  }

  console.log('\n清空对话不该丢掉画布上的操作记录');

  {
    // pendingEvents 装的是**画布上的操作**(删了一张卡、拖过滑块),不是对话内容。
    // 清空对话并不会撤销那些操作,所以记录也不该跟着消失 ——
    // 否则"删掉一张卡、清空对话、再提问"这条路径上,模型会以为那张卡从没存在过。
    resetStore();
    store().addArtifact(PLOT, 'y = x', 'ai');
    store().pushEvent({ type: 'remove', artifactId: store().artifacts[0].id, title: 'y = x' });
    store().pushMessage({ role: 'user', content: '问题' });

    store().clearConversation();

    ok('消息清空了', msgs().length === 0);
    ok('操作记录保留下来', store().pendingEvents.length === 1, String(store().pendingEvents.length));
    ok('保留的正是那条删除', store().pendingEvents[0].type === 'remove');
  }

  {
    // 拖滑块也一样
    resetStore();
    store().addArtifact(PLOT, 'y = x', 'ai');
    store().pushEvent({ type: 'paramChange', artifactId: store().artifacts[0].id, param: 'a', value: 2 });
    store().clearConversation();
    ok('滑块操作也保留', store().pendingEvents.length === 1, String(store().pendingEvents.length));
  }

  console.log(`\n${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

void main();
