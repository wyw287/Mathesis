import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage, type StorageTier } from '../lib/idb-storage';
import {
  type ArtifactIndexEntry,
  type ArtifactSpec,
  type CanvasArtifact,
  type CanvasEvent,
  CURRENT_SCHEMA_VERSION,
  toIndexEntry,
} from '../types/artifact';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 某些第三方中转不支持 tool calling,关掉后走「模型输出带标记的文本块」降级路径。 */
  toolsEnabled: boolean;
  /**
   * 单次回复的输出上限。null = 不发送这个字段,用服务商自己的默认值。
   *
   * **默认必须是 null。** 我一开始设成 8192,理由是"多数模型都能接受" ——
   * 那是错的,而且错得很难发现:很多服务商的推理模型让思维链和正文**共享**
   * 这一份预算,思考一次就可能写掉两万 token。给一个偏小的值,等于主动掐死
   * 这些模型,表现为思考到一半被截断、正文一个字都没有。
   *
   * 不发这个字段时,服务商用自己的默认值(思考模式常见 64K),那通常是对的。
   * 只有当默认值明显偏小、出现截断时,才需要显式给一个大值。
   */
  maxTokens: number | null;
  /**
   * 思考强度。null = 不发送,用服务商自己的默认值。
   *
   * 各家取值不同,所以只给最通用的三档:DeepSeek 认 low/high/max
   * (medium 会被映射成 high),OpenAI 还认 none/minimal/xhigh。
   * 默认不发送 —— DeepSeek 的默认是 high,那是个合理的起点,
   * 而且乱发一个服务商不认的值有被 400 拒绝的风险。
   */
  reasoningEffort: ReasoningEffort | null;
}

export type ReasoningEffort = 'low' | 'high' | 'max';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  content: string;
  /**
   * 推理模型的思维链。只用于展示,不回灌给模型(DeepSeek 这类也不接受把它塞回上下文)。
   *
   * **不落盘** —— 每条可能是上万字符,跟着 messages 一起存,聊几十轮就把
   * localStorage 撑爆了。它的价值在当下那一轮,刷新页面之后丢掉是可以接受的。
   */
  reasoning?: string;
  /** 这条消息触发了哪些工具,用于在对话流里显示可点击的 artifact 引用。 */
  artifactIds?: string[];
  createdAt: number;
}

/**
 * 学生对一张 artifact 做过的交互。
 *
 * 这是「教学状态」的最小可用切片。此前模型能看到的只有**画布**,看不到**学习者** ——
 * 它不知道哪个滑块被拖过十二次、哪一步被标了"不懂"、哪张测验还没做。
 * 于是"主动引导"实际上做不起来:诊断不了,就谈不上脚手架、节奏控制和主动出题。
 *
 * 刻意只记录**已经发生的事实**,不推断掌握度。掌握度是需要验证的模型,
 * 而"这一步被点开过三次"是个可以直接用的事实。
 */
export interface InteractionStats {
  paramChanges: number;
  /** 点过"这步不懂"的步骤。最强的困惑信号。 */
  confusedSteps: string[];
  expandedSteps: string[];
  answers: number;
  lastTouchedAt: number;
}

const EMPTY_STATS = (): InteractionStats => ({
  paramChanges: 0,
  confusedSteps: [],
  expandedSteps: [],
  answers: 0,
  lastTouchedAt: 0,
});

/**
 * 把一次画布事件累加进统计。
 *
 * 只有真正表达"做了什么"的事件才计数。select / viewport 只更新最后触碰时间 ——
 * 它们能说明"看过",但没法可靠地区分扫一眼和认真看,拿去当教学信号会误导。
 * 所以目录里的标注含义是"没有做过交互操作",不等于"没看过"。
 */
function bumpInteraction(
  all: Record<string, InteractionStats>,
  e: CanvasEvent,
): Record<string, InteractionStats> {
  const cur = all[e.artifactId] ?? EMPTY_STATS();
  const next: InteractionStats = { ...cur, lastTouchedAt: Date.now() };
  const uniq = (xs: string[]) => [...new Set(xs)];

  switch (e.type) {
    case 'paramChange':
      next.paramChanges = cur.paramChanges + 1;
      break;
    case 'stepConfused':
      next.confusedSteps = uniq([...cur.confusedSteps, e.stepId]);
      break;
    case 'stepExpand':
      next.expandedSteps = uniq([...cur.expandedSteps, e.stepId]);
      break;
    case 'answer':
      next.answers = cur.answers + 1;
      break;
    default:
      break;
  }
  return { ...all, [e.artifactId]: next };
}

/** 当前这一步在干什么。请求可能耗时几十秒,没有这个学生只会看到界面卡住。 */
export interface RunStatus {
  phase: string;
  startedAt: number;
  /**
   * 推理模型思考期间已经产出的字数。
   *
   * 没有它,推理模型的表现就是"点完发送,界面一动不动几十秒" —— 学生分不清
   * 是在思考还是死了。数字本身没有意义,它的作用是证明"它在动"。
   */
  reasoningChars?: number;
}

/** 协议层的原始消息历史(含 tool_calls / tool 结果),和展示用的 messages 分开存。 */
export type ApiMessage = Record<string, unknown>;

/**
 * 一个会话的完整内容。
 *
 * 顶层仍然保留 `artifacts` / `runtime` / `interactions` / `messages` 这些**扁平字段**,
 * 它们是**当前会话的活工作集**;这个类型是已经提交下来的快照。
 * 切换会话时:先把活工作集 commit 进 `sessions[旧 id]`,再把 `sessions[新 id]` 装回顶层。
 *
 * 为什么用「扁平镜像 + 提交」而不是把顶层整个嵌进 `sessions[activeId]`:
 * `agent.ts` 里有七处 `setState` 直接写扁平字段,其中 `appendToMessage` 在流式回复中
 * 会被调用上千次。嵌套形状下它们**全都要改成会话目标化写入**,而且这些写法不受
 * action 签名保护、极易漏。扁平镜像让它们一行都不用改。
 *
 * 代价是内存里有两种表示。用 `snapshot` / `loadInto` 两个纯函数把它收敛到一处,
 * 只在「切换会话」和「落盘 / 载入」时使用。
 */
export interface SessionData {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 归档只是从列表里收起来,内容仍在。为将来的分组/分页留的口子。 */
  archived: boolean;
  artifacts: CanvasArtifact[];
  runtime: Record<string, Record<string, number>>;
  interactions: Record<string, InteractionStats>;
  messages: ChatMessage[];
}

/** 真正落盘的东西。刻意很窄:只在 partialize 里构造,别处不碰。 */
interface PersistedShape {
  settings: Settings;
  sessions: Record<string, SessionData>;
  activeSessionId: string;
  legacyImported: boolean;
}

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function blankSession(id: string, title = '新会话'): SessionData {
  const now = Date.now();
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    archived: false,
    artifacts: [],
    runtime: {},
    interactions: {},
    messages: [],
  };
}

/**
 * 把活工作集拍成一个会话快照。
 *
 * **顺手剥掉思维链。** 它每条可能上万字符,是 messages 里唯一会撑爆存储的东西,
 * 而价值只在产出它的那一轮。在这里剥(而不是落盘时剥)还有个好处:
 * 已经提交的会话记录永远不带它,落盘时就只需要处理当前这一个会话。
 */
function snapshot(s: SessionState): SessionData {
  const base = s.sessions[s.activeSessionId] ?? blankSession(s.activeSessionId);
  return {
    ...base,
    artifacts: s.artifacts,
    runtime: s.runtime,
    interactions: s.interactions,
    messages: s.messages.map(({ reasoning: _drop, ...m }) => m),
    updatedAt: Date.now(),
  };
}

/**
 * 把会话记录装进活工作集。
 *
 * 易失字段一律清空:它们不属于任何会话快照。`apiHistory` 尤其重要 ——
 * 它含工具调用细节,跨会话携带会让新会话看到不相干的工具结果。
 */
function loadInto(sess: SessionData) {
  return {
    artifacts: sess.artifacts,
    runtime: sess.runtime,
    interactions: sess.interactions,
    messages: sess.messages,
    apiHistory: [] as ApiMessage[],
    pendingEvents: [] as CanvasEvent[],
    focusId: undefined as string | undefined,
  };
}

/** 挑一个可用的会话:优先未归档的,其次任意一个。 */
function pickNextActive(
  sessions: Record<string, SessionData>,
  excludeId?: string,
): SessionData | undefined {
  const rest = Object.values(sessions).filter((s) => s.id !== excludeId);
  return rest.find((s) => !s.archived) ?? rest[0];
}

/**
 * 保证 `activeSessionId` 指向一个**存在**的会话,悬空时挪到别的、一个都没有就新建。
 *
 * 它可能悬空:删除、存档写了一半、或者载入时存档里根本没有会话。
 * 一旦悬空,所有选择器都返回 `undefined`,界面会是白的但看不出原因。
 * 与其在每个调用点防御,不如在这里兜住,并且顺手把活工作集装好。
 *
 * 刻意**不检查 archived** —— 点开一个已归档的会话是合法操作(那就是恢复它的方式之一)。
 * 归档"当前会话"的处理放在 archiveSession 里,那里意图更清楚。
 */
function activate(
  sessions: Record<string, SessionData>,
  currentId: string,
): Partial<SessionState> {
  if (sessions[currentId]) return {};

  const next = pickNextActive(sessions);
  if (next) return { activeSessionId: next.id, ...loadInto(next) };

  // 删光了也不能没有会话可用
  const fresh = blankSession(uid());
  return {
    sessions: { ...sessions, [fresh.id]: fresh },
    activeSessionId: fresh.id,
    ...loadInto(fresh),
  };
}

/** 挪到一个可用的会话上。用于"当前会话刚被归档/删除"之后的收尾。 */
function moveAwayFrom(
  sessions: Record<string, SessionData>,
  leavingId: string,
): Partial<SessionState> {
  const next = pickNextActive(sessions, leavingId);
  if (next) return { activeSessionId: next.id, ...loadInto(next) };
  const fresh = blankSession(uid());
  return {
    sessions: { ...sessions, [fresh.id]: fresh },
    activeSessionId: fresh.id,
    ...loadInto(fresh),
  };
}

/** 旧版本(localStorage 时代)的数据。读 localStorage 是同步的,所以导入也是。 */
const LEGACY_KEY = 'mathesis.session';

function readLegacySession(): SessionData | null {
  // node 里(测试脚本)根本没有 localStorage,那不是"导入失败",别当成异常报出来
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const st = parsed?.state;
    if (!st || !Array.isArray(st.artifacts)) return null;
    const id = uid();
    const now = Date.now();
    return {
      id,
      title: '我的学习',
      createdAt: now,
      updatedAt: now,
      archived: false,
      artifacts: st.artifacts as CanvasArtifact[],
      runtime: (st.runtime as SessionData['runtime']) ?? {},
      interactions: (st.interactions as SessionData['interactions']) ?? {},
      messages: (st.messages as SessionData['messages']) ?? [],
    };
  } catch (e) {
    console.warn('[mathesis] 旧数据导入失败,当作没有旧数据', e);
    return null;
  }
}

interface SessionState {
  settings: Settings;

  // —— 多会话 ——
  /** 已提交的会话快照。当前会话的活工作集在下面那些扁平字段里。 */
  sessions: Record<string, SessionData>;
  activeSessionId: string;
  /**
   * 旧的 localStorage 数据是否已尝试导入。
   *
   * 必须**落盘**:否则用户删光会话之后,下次载入又会把已经删掉的旧数据"复活"。
   * 没找到旧数据时也要置 true,免得每次载入都扫一遍。
   */
  legacyImported: boolean;
  /** 水合是否完成。异步存储下首帧是空的,界面要等这个。 */
  hydrated: boolean;
  /** 实际落在哪一级存储。memory 表示内容不会被保存,界面必须说出来。 */
  storageTier: StorageTier;

  newSession: () => void;
  switchSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** 把活工作集提交进 `sessions[activeSessionId]`。切会话和落盘前都要调。 */
  commitActive: () => void;
  /** 水合收尾:导入旧数据、保证至少有一个可用会话、置 hydrated。 */
  finishHydration: (tier: StorageTier) => void;

  // —— 当前会话的活工作集 ——
  artifacts: CanvasArtifact[];
  /** 滑块的运行时值。**不进 spec,不进持久化的语义状态,不发回模型。** */
  runtime: Record<string, Record<string, number>>;
  /** 学生对每张 artifact 做过的交互。会进模型每轮看到的目录。 */
  interactions: Record<string, InteractionStats>;
  messages: ChatMessage[];
  apiHistory: ApiMessage[];
  pendingEvents: CanvasEvent[];
  focusId?: string;
  busy: boolean;
  status: RunStatus | null;

  setSettings: (patch: Partial<Settings>) => void;
  addArtifact: (spec: ArtifactSpec, title: string, origin: 'ai' | 'user') => string;
  /**
   * title 由调用方给出,而不是在这里算。
   *
   * 因为算标题要认识所有 kind,那会把 store 拖去依赖注册表;而渲染器又要读 store,
   * 于是形成 store → 注册表 → kind 模块 → store 的环。
   * 调用方(工具层)本来就已经拿到了新 spec,顺手算一下标题是最自然的。
   */
  patchArtifact: (id: string, patch: Partial<ArtifactSpec>, title: string) => void;
  removeArtifact: (id: string) => void;
  setParam: (id: string, name: string, value: number) => void;
  setFocus: (id?: string) => void;

  artifactIndex: () => ArtifactIndexEntry[];
  getArtifact: (id: string) => CanvasArtifact | undefined;

  pushMessage: (m: Omit<ChatMessage, 'id' | 'createdAt'>) => string;
  appendToMessage: (id: string, delta: string) => void;
  appendReasoning: (id: string, delta: string) => void;
  pushApi: (...m: ApiMessage[]) => void;
  setStatus: (phase: string | null) => void;
  setReasoningChars: (n: number) => void;

  pushEvent: (e: CanvasEvent) => void;
  drainEvents: () => CanvasEvent[];
  /** 清空**当前会话**的对话,不动画布。会话本身还在。 */
  clearConversation: () => void;
}

const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  toolsEnabled: true,
  // 不发这个字段。见 Settings.maxTokens 的注释 —— 给推理模型设一个偏小的上限
  // 比完全不设更糟,因为它会把思维链一起掐掉。
  maxTokens: null,
  // 也不发思考强度。DeepSeek 默认就是 high,是个合理的起点。
  reasoningEffort: null,
};

/**
 * 初始会话。
 *
 * 一上来就建一个空会话,是为了让「`activeSessionId` 永远指向一个存在的记录」
 * 这条不变式从第一帧就成立 —— 否则水合完成之前所有选择器都会拿到 undefined。
 * 如果存档里有会话,merge 会把这一整套整个换掉。
 */
const FIRST_SESSION = blankSession(uid());

const persistStorage = createPersistStorage<PersistedShape>();

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      sessions: { [FIRST_SESSION.id]: FIRST_SESSION },
      activeSessionId: FIRST_SESSION.id,
      legacyImported: false,
      hydrated: false,
      storageTier: 'memory' as StorageTier,
      artifacts: [],
      runtime: {},
      interactions: {},
      messages: [],
      apiHistory: [],
      pendingEvents: [],
      focusId: undefined,
      busy: false,
      status: null,

      // ------------------------------------------------------------ 会话

      commitActive: () =>
        set((s) => ({ sessions: { ...s.sessions, [s.activeSessionId]: snapshot(s) } })),

      switchSession: (id) =>
        set((s) => {
          const target = s.sessions[id];
          if (!target || id === s.activeSessionId) return {};
          // **先提交当前会话再切走。** 这是整个会话机制里最容易漏的一步 ——
          // 漏了就等于把当前这块工作丢了。
          const sessions = { ...s.sessions, [s.activeSessionId]: snapshot(s) };
          return { sessions, activeSessionId: id, ...loadInto(target) };
        }),

      newSession: () =>
        set((s) => {
          const fresh = blankSession(uid());
          const sessions = { ...s.sessions, [s.activeSessionId]: snapshot(s), [fresh.id]: fresh };
          return { sessions, activeSessionId: fresh.id, ...loadInto(fresh) };
        }),

      renameSession: (id, title) =>
        set((s) => {
          const target = s.sessions[id];
          const clean = title.trim();
          if (!target || !clean) return {};
          return {
            sessions: { ...s.sessions, [id]: { ...target, title: clean, updatedAt: Date.now() } },
          };
        }),

      archiveSession: (id) =>
        set((s) => {
          const target = s.sessions[id];
          if (!target) return {};
          const sessions = {
            ...s.sessions,
            [id]: { ...target, archived: true, updatedAt: Date.now() },
          };
          // 归档的正好是当前会话 → 得挪走,不能停在一个已经收起来的上面
          if (id !== s.activeSessionId) return { sessions };
          return { sessions, ...moveAwayFrom(sessions, id) };
        }),

      unarchiveSession: (id) =>
        set((s) => {
          const target = s.sessions[id];
          if (!target) return {};
          return {
            sessions: { ...s.sessions, [id]: { ...target, archived: false, updatedAt: Date.now() } },
          };
        }),

      deleteSession: (id) =>
        set((s) => {
          if (!s.sessions[id]) return {};
          const sessions = { ...s.sessions };
          delete sessions[id];
          if (id !== s.activeSessionId) return { sessions };
          return { sessions, ...activate(sessions, id) };
        }),

      finishHydration: (tier) =>
        set((s) => {
          let sessions = s.sessions;
          let legacyImported = s.legacyImported;

          // 旧数据导入。读 localStorage 是同步的,所以这里不需要异步 ——
          // 而 zustand 的后置水合回调**不会被 await**,在里面 await 会造出
          // 两个互相打架的 hydrated。
          if (!legacyImported) {
            legacyImported = true;
            const legacy = readLegacySession();
            // 只在存档确实是空的时候导入。已经用过多会话的用户不该被塞进一段旧数据。
            if (legacy && Object.keys(sessions).length === 0) {
              sessions = { ...sessions, [legacy.id]: legacy };
            }
          }

          return {
            sessions,
            legacyImported,
            hydrated: true,
            storageTier: tier,
            ...activate(sessions, s.activeSessionId),
          };
        }),

      clearConversation: () =>
        set(() => ({ messages: [], apiHistory: [], pendingEvents: [] })),

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      addArtifact: (spec, title, origin) => {
        const id = uid();
        const now = Date.now();
        const art: CanvasArtifact = {
          id,
          spec,
          rev: 1,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          origin,
          title,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ artifacts: [...s.artifacts, art], focusId: id }));
        return id;
      },

      patchArtifact: (id, patch, title) =>
        set((s) => ({
          artifacts: s.artifacts.map((a) => {
            if (a.id !== id) return a;
            // 浅合并:数组整体替换。深合并对 curves 这类数组语义不明确。
            const spec = { ...a.spec, ...patch } as ArtifactSpec;
            return { ...a, spec, title, rev: a.rev + 1, updatedAt: Date.now() };
          }),
        })),

      removeArtifact: (id) =>
        set((s) => ({
          artifacts: s.artifacts.filter((a) => a.id !== id),
          focusId: s.focusId === id ? undefined : s.focusId,
        })),

      setParam: (id, name, value) =>
        set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], [name]: value } } })),

      setFocus: (id) => set({ focusId: id }),

      artifactIndex: () => get().artifacts.map(toIndexEntry),
      getArtifact: (id) => get().artifacts.find((a) => a.id === id),

      pushMessage: (m) => {
        const id = uid();
        set((s) => ({ messages: [...s.messages, { ...m, id, createdAt: Date.now() }] }));
        return id;
      },

      appendToMessage: (id, delta) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)),
        })),

      appendReasoning: (id, delta) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, reasoning: (m.reasoning ?? '') + delta } : m,
          ),
        })),

      pushApi: (...m) => set((s) => ({ apiHistory: [...s.apiHistory, ...m] })),
      setStatus: (phase) =>
        set({ status: phase === null ? null : { phase, startedAt: Date.now(), reasoningChars: 0 } }),
      // 单独一个动作,而不是复用 setStatus —— 后者会重置 startedAt,
      // 那样计时器会随着思考进度不断归零,学生永远看不到真实耗时。
      setReasoningChars: (n) =>
        set((s) => (s.status ? { status: { ...s.status, reasoningChars: n } } : {})),

      pushEvent: (e) =>
        set((s) => ({
          pendingEvents: [...s.pendingEvents, e],
          // 删除要顺手清掉它的统计,否则这份 map 会随删掉的卡片一起无限增长
          interactions:
            e.type === 'remove'
              ? Object.fromEntries(Object.entries(s.interactions).filter(([k]) => k !== e.artifactId))
              : bumpInteraction(s.interactions, e),
        })),
      drainEvents: () => {
        const evs = get().pendingEvents;
        set({ pendingEvents: [] });
        return evs;
      },

    }),
    {
      name: 'mathesis.session',
      /**
       * 显式声明版本。
       *
       * zustand 在版本不匹配又没有 `migrate` 时的行为是 `console.error` 之后
       * **静默丢弃存档**。写一个数字,至少让以后真需要迁移时有地方可挂。
       */
      version: 1,
      storage: persistStorage,
      /**
       * 落盘形状刻意很窄。
       *
       * 注意这里**要把活工作集合进 sessions[activeSessionId]** —— 活工作集本身
       * 不以扁平字段落盘(那样会和已提交的记录重复且容易不一致),它在落盘这一刻
       * 才被拍成快照。这是全项目仅有的两处"活工作集 ↔ 会话记录"转换之一。
       *
       * 因为 `snapshot` 已经剥掉了思维链,这里不需要再处理 messages。
       */
      partialize: (s) => ({
        settings: s.settings,
        sessions: { ...s.sessions, [s.activeSessionId]: snapshot(s) },
        activeSessionId: s.activeSessionId,
        legacyImported: s.legacyImported,
      }),
      /**
       * 载入:把存档拆回"活工作集 + 会话记录"两种表示。
       *
       * 不做标题重算和 schema 迁移 —— 那两件事需要认识所有 kind,由 registry 负责
       * (`reconcileArtifacts`),放在这里会形成 store → 注册表 → kind 模块 → store 的环。
       */
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedShape>;
        const sessions = p.sessions ?? {};
        const activeId = p.activeSessionId && sessions[p.activeSessionId]
          ? p.activeSessionId
          : (Object.keys(sessions)[0] ?? current.activeSessionId);
        const active = sessions[activeId] ?? blankSession(activeId);

        return {
          ...current, // 动作函数必须来自 current,不能被持久化数据盖掉
          settings: { ...current.settings, ...(p.settings ?? {}) },
          sessions,
          activeSessionId: activeId,
          // legacyImported 必须从这里恢复:它是"落盘字段",不是易失字段。
          // 当成易失的重置掉,会导致用户删光会话后旧数据"复活"。
          legacyImported: p.legacyImported ?? false,
          ...loadInto(active),
          // 易失字段一律取初值,不接受任何残留
          busy: false,
          status: null,
          hydrated: false,
          storageTier: 'memory',
        };
      },
      /**
       * 水合收尾。
       *
       * zustand 的后置回调**不会被 await** —— 回调返回后它立刻把 hasHydrated 置真。
       * 所以这里必须**同步**做完所有事,并且用 try/finally 保证失败路径也置
       * `hydrated`,否则一次 IndexedDB 报错就会让界面永远停在占位状态。
       */
      onRehydrateStorage: () => (state) => {
        const tier = persistStorage.tier();
        try {
          state?.finishHydration(tier);
        } catch (e) {
          console.warn('[mathesis] 水合收尾失败,用初始状态继续', e);
        } finally {
          // 无论走哪条路径都必须置 hydrated —— 否则界面永远停在占位状态,
          // 而用户看到的是一个永远不动的"载入中"。
          useSession.setState({ hydrated: true, storageTier: tier });
        }
      },
    },
  ),
);
