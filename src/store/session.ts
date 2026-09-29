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
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  content: string;
  /** 这条消息触发了哪些工具,用于在对话流里显示可点击的 artifact 引用。 */
  artifactIds?: string[];
  createdAt: number;
}

/** 当前这一步在干什么。请求可能耗时几十秒,没有这个学生只会看到界面卡住。 */
export interface RunStatus {
  phase: string;
  startedAt: number;
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
  messages: ChatMessage[];
  apiHistory: ApiMessage[];
  pendingEvents: CanvasEvent[];
  focusId?: string;
  busy: boolean;
  status: RunStatus | null;

  setSettings: (patch: Partial<Settings>) => void;
  addArtifact: (spec: ArtifactSpec, title: string, origin: 'ai' | 'user', refs?: string[]) => string;
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
  pushApi: (...m: ApiMessage[]) => void;
  setBusy: (b: boolean) => void;
  setStatus: (phase: string | null) => void;

  pushEvent: (e: CanvasEvent) => void;
  drainEvents: () => CanvasEvent[];
  reset: () => void;
}

const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  toolsEnabled: true,
};

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      artifacts: [],
      runtime: {},
      messages: [],
      apiHistory: [],
      pendingEvents: [],
      focusId: undefined,
      busy: false,
      status: null,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      addArtifact: (spec, title, origin, refs = []) => {
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
          refs,
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

      pushApi: (...m) => set((s) => ({ apiHistory: [...s.apiHistory, ...m] })),
      setBusy: (busy) => set({ busy }),
      setStatus: (phase) => set({ status: phase === null ? null : { phase, startedAt: Date.now() } }),

      pushEvent: (e) => set((s) => ({ pendingEvents: [...s.pendingEvents, e] })),
      drainEvents: () => {
        const evs = get().pendingEvents;
        set({ pendingEvents: [] });
        return evs;
      },

      reset: () =>
        set({ artifacts: [], runtime: {}, messages: [], apiHistory: [], pendingEvents: [], focusId: undefined }),
    }),
    {
      name: 'mathesis.session',
      // apiHistory / pendingEvents / busy 是易失的,不落盘
      partialize: (s) => ({
        settings: s.settings,
        artifacts: s.artifacts,
        runtime: s.runtime,
        messages: s.messages,
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
