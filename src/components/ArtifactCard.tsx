import { useCallback } from 'react';
import { kindModule } from '../kinds/registry';
import { useSession } from '../store/session';
import type { CanvasArtifact, CanvasEvent } from '../types/artifact';

const KIND_LABEL: Record<string, string> = {
  plot2d: '图像',
  derivation: '推导',
  quiz: '测验',
  html: '交互',
};

interface Props {
  artifact: CanvasArtifact;
  focused: boolean;
}

export function ArtifactCard({ artifact, focused }: Props) {
  const emit = useCallback((e: CanvasEvent) => {
    const store = useSession.getState();
    store.pushEvent(e);
    // stepConfused / answer 是学生的求救信号,必须立刻转发给模型;
    // 其余事件先攒着,由学生下一次开口时一起带过去 —— 拖滑块这类操作大多不需要 AI 介入。
    //
    // 这里刻意**不** drainEvents:交给 send() 自己去取。否则一旦 send() 因为
    // 模型正在输出而提前返回,这些已经被取出来的事件就永远丢了。
    if (e.type === 'stepConfused' || e.type === 'answer') {
      void import('../llm/agent').then((m) => m.send({}));
    }
  }, []);

  const setFocus = () => useSession.getState().setFocus(artifact.id);
  const remove = () => {
    // 先发事件再删。删除是唯一一条不走工具调用的画布变更 —— 创建和修改模型都
    // 能在工具结果里看到,删除如果也不告诉它,它下一轮只看到目录里少了一项,
    // 分不清"被删了"和"从没存在过"。
    emit({ type: 'remove', artifactId: artifact.id, title: artifact.title });
    useSession.getState().removeArtifact(artifact.id);
  };

  return (
    <section className={focused ? 'artifact focused' : 'artifact'} onMouseDown={setFocus}>
      <header className="artifact-head">
        <span className={`kind kind-${artifact.spec.kind}`}>
          {KIND_LABEL[artifact.spec.kind] ?? artifact.spec.kind}
        </span>
        <h3 className="artifact-title">{artifact.title}</h3>
        <span className="artifact-id" title="对话里可以按这个 id 引用它">
          {artifact.id.slice(0, 4)}
        </span>
        {artifact.rev > 1 && (
          <span className="rev" title={`已修订 ${artifact.rev - 1} 次`}>
            r{artifact.rev}
          </span>
        )}
        <button className="icon-btn" onClick={remove} title="从画布移除">
          ✕
        </button>
      </header>
      <ArtifactBody artifact={artifact} emit={emit} />
    </section>
  );
}

interface BodyProps {
  artifact: CanvasArtifact;
  emit: (e: CanvasEvent) => void;
}

/**
 * 按 kind 分派到对应的渲染器。
 *
 * 这里没有 switch,也没有 default —— 直接查注册表。所以**不可能漏掉某个 kind**:
 * 「注册表要覆盖所有 kind」这件事由 kinds/registry.ts 的编译期断言保证,
 * 而不是靠在这个文件里记得加一个 case。新增 kind 时这个文件一行都不用动。
 */
function ArtifactBody({ artifact, emit }: BodyProps) {
  const mod = kindModule(artifact.spec.kind);
  if (!mod) {
    // 只有一种情况会走到这里:本地存着"未来版本的前端"创建的 artifact。
    // 不能崩,也不能静默丢弃 —— 学生三个月前存的推导不能因为一次降级就消失。
    return <div className="unknown-kind">这个内容需要更新版本才能显示。</div>;
  }
  const { Body } = mod;
  return <Body spec={artifact.spec} artifactId={artifact.id} rev={artifact.rev} emit={emit} />;
}
