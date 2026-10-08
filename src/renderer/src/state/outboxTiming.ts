// Paint marks require a mounted virtual-log row; hidden channels do not claim a paint.
export function markSend(phase: string, nonce: string): void {
  performance.mark(`cp:send:${phase}`, { detail: { nonce } });
}

export function markSendPaint(phase: 'pending-painted' | 'sent-row-painted', nonce: string, key: string): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const selector = `[data-row-key="${CSS.escape(key)}"]`;
  requestAnimationFrame(() => {
    if (!document.querySelector(selector)) return;
    requestAnimationFrame(() => {
      if (document.querySelector(selector)) markSend(phase, nonce);
    });
  });
}
