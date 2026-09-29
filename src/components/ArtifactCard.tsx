import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSession } from '../store/session';
import type { CanvasArtifact, CanvasEvent } from '../types/artifact';
import { Derivation } from '../renderers/Derivation';
import { HtmlBlock } from '../renderers/HtmlBlock';
import { Plot2D } from '../renderers/Plot2D';
import { Quiz } from '../renderers/Quiz';

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
  const remove = () => useSession.getState().removeArtifact(artifact.id);

  return (
    <section className={focused ? 'artifact focused' : 'artifact'} onMouseDown={setFocus}>
      <header className="artifact-head">
        <span className={`kind kind-${artifact.spec.kind}`}>{KIND_LABEL[artifact.spec.kind] ?? artifact.spec.kind}</span>
        <h3 className="artifact-title">{artifact.title}</h3>
        <span className="artifact-id" title="对话里可以按这个 id 引用它">
          {artifact.id.slice(0, 4)}
        </span>
        {artifact.rev > 1 && <span className="rev" title={`已修订 ${artifact.rev - 1} 次`}>
          r{artifact.rev}
        </span>}
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

function ArtifactBody({ artifact, emit }: BodyProps) {
  const { spec } = artifact;
  // 滑块运行时值不属于 spec,单独从 store 取 —— 见 docs/artifact-schema.md §1
  // useShallow 是必须的:选择器每次都会构造新对象,zustand v5 默认按 Object.is 比较,
  // 不加浅比较会无限重渲染。
  const scope = useSession(
    useShallow((s) =>
      spec.kind === 'plot2d' ? { ...defaultsOf(artifact), ...s.runtime[artifact.id] } : EMPTY,
    ),
  );
  const setParam = useSession((s) => s.setParam);

  switch (spec.kind) {
    case 'plot2d':
      return (
        <Plot2D
          spec={spec}
          scope={scope}
          artifactId={artifact.id}
          rev={artifact.rev}
          emit={emit}
          onParam={(name, value) => setParam(artifact.id, name, value)}
        />
      );
    case 'derivation':
      return <Derivation spec={spec} artifactId={artifact.id} emit={emit} />;
    case 'quiz':
      return <Quiz spec={spec} artifactId={artifact.id} emit={emit} />;
    case 'html':
      return <HtmlBlock spec={spec} artifactId={artifact.id} emit={emit} />;
    default:
      // 不认识的新 kind:不能崩,也不能静默丢掉 —— 学生存的推导不能因为一次前端升级就消失
      return <div className="unknown-kind">这个内容需要更新版本才能显示。</div>;
  }
}

const EMPTY: Record<string, number> = {};

function defaultsOf(a: CanvasArtifact): Record<string, number> {
  if (a.spec.kind !== 'plot2d') return EMPTY;
  const out: Record<string, number> = {};
  for (const p of a.spec.params ?? []) out[p.name] = p.value;
  return out;
}
