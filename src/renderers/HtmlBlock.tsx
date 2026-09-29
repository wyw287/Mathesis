import { useEffect, useRef } from 'react';
import type { CanvasEvent, HtmlSpec } from '../types/artifact';

interface Props {
  spec: HtmlSpec;
  artifactId: string;
  emit: (e: CanvasEvent) => void;
}

/**
 * Tier 2 逃生舱口:模型直接生成 HTML。
 *
 * sandbox 只给 allow-scripts,**绝不能加 allow-same-origin** ——
 * 两者同时给等于没有沙箱,iframe 里的脚本能直接摸到 localStorage 里的 API Key。
 * 交互通过 postMessage 回传,约定消息形如 { __mathesis: true, event: {...} }。
 */
export function HtmlBlock({ spec, artifactId, emit }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== ref.current?.contentWindow) return;
      const data = ev.data;
      if (!data || data.__mathesis !== true || !data.event) return;
      emit({ ...(data.event as CanvasEvent), artifactId });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [artifactId, emit]);

  return (
    <iframe
      ref={ref}
      className="html-block"
      title="交互内容"
      sandbox="allow-scripts"
      srcDoc={spec.html}
      height={spec.height ?? 360}
    />
  );
}
