import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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

/** 当前这一步在干什么。请求可能耗时几十秒,没有这个学生只会看到界面卡住。 */export interface RunStatus {
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

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface SessionState {
  settings: Settings;
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
  paramScope: (id: string) => Record<string, number>;
  setFocus: (id?: string) => void;

  artifactIndex: () => ArtifactIndexEntry[];
  getArtifact: (id: string) => CanvasArtifact | undefined;

  pushMessage: (m: Omit<ChatMessage, 'id' | 'createdAt'>) => string;
  appendToMessage: (id: string, delta: string) => void;
  appendReasoning: (id: string, delta: string) => void;
  pushApi: (...m: ApiMessage[]) => void;
  setBusy: (b: boolean) => void;
  setStatus: (phase: string | null) => void;
  setReasoningChars: (n: number) => void;

  pushEvent: (e: CanvasEvent) => void;
  drainEvents: () => CanvasEvent[];
  reset: () => void;
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

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      artifacts: [],
      runtime: {},
      interactions: {},
      messages: [],
      apiHistory: [],
      pendingEvents: [],
      focusId: undefined,
      busy: false,
      status: null,

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

      paramScope: (id) => {
        const art = get().artifacts.find((a) => a.id === id);
        const defaults: Record<string, number> = {};
        if (art && art.spec.kind === 'plot2d') {
          for (const p of art.spec.params ?? []) defaults[p.name] = p.value;
        }
        return { ...defaults, ...get().runtime[id] };
      },

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
      setBusy: (busy) => set({ busy }),
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

      reset: () =>
        set({
        artifacts: [],
        runtime: {},
        interactions: {},
        messages: [],
        apiHistory: [],
        pendingEvents: [],
        focusId: undefined,
      }),
    }),
    {
      name: 'mathesis.session',
      // apiHistory / pendingEvents / busy 是易失的,不落盘
      partialize: (s) => ({
        settings: s.settings,
        artifacts: s.artifacts,
        runtime: s.runtime,
        interactions: s.interactions,
        // 思维链单独剥掉:每条可能上万字符,聊几十轮就会把 localStorage 撑爆。
        // 它的价值在产出它的那一轮,刷新后丢掉可以接受。
        messages: s.messages.map(({ reasoning: _drop, ...m }) => m),
      }),
      // 不做标题重算和 schema 迁移 —— 那两件事需要认识所有 kind,由 registry 负责。
      // 迁移在 App 挂载时跑一次(见 reconcile())。放在这里会形成
      // store → 注册表 → kind 模块 → store 的环。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SessionState>;
        return {
          ...current, // 动作函数必须来自 current,不能被持久化数据盖掉
          settings: { ...current.settings, ...(p.settings ?? {}) },
          artifacts: p.artifacts ?? [],
          runtime: p.runtime ?? {},
          interactions: p.interactions ?? {},
          messages: p.messages ?? [],
          // 易失字段一律取初值,不接受任何残留
          apiHistory: [],
          pendingEvents: [],
          busy: false,
          status: null,
          focusId: undefined,
        };
      },
    },
  ),
);
