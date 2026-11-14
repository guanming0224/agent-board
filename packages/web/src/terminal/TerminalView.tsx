import { useEffect, useRef, type CSSProperties } from 'react';
import type { TerminalViewProps } from '../shared/terminal-contract';
import { TerminalController } from './controller';

const containerStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: 'var(--term-bg)',
};

/** 原生 CLI 的畫面，外框之內不疊任何東西。尺寸由父層決定，父層要有明確高度。 */
export function TerminalView({
  sessionId,
  stream,
  visible = true,
  autoFocus = false,
  className,
  onSizeOwnerChange,
  scrollback,
  webgl,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  // callback 換了不重建終端機，用 ref 拿最新的。
  const onSizeOwnerRef = useRef(onSizeOwnerChange);
  onSizeOwnerRef.current = onSizeOwnerChange;

  useEffect(() => {
    const controller = new TerminalController(
      containerRef.current!,
      sessionId,
      stream,
      visible,
      (owner) => onSizeOwnerRef.current?.(owner),
      { scrollback, webgl },
    );
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
      onSizeOwnerRef.current?.(null);
    };
    // visible、scrollback、webgl 只取建立當下的值，之後的變化由下面的 effect 處理，不重建終端機。
  }, [sessionId, stream]);

  useEffect(() => {
    controllerRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (scrollback !== undefined) controllerRef.current?.setScrollback(scrollback);
  }, [scrollback]);

  useEffect(() => {
    controllerRef.current?.setWebglPreferred(webgl ?? true);
  }, [webgl]);

  useEffect(() => {
    if (autoFocus && visible) controllerRef.current?.focus();
  }, [autoFocus, visible, sessionId, stream]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      data-terminal-session={sessionId}
    />
  );
}
