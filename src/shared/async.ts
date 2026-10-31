/** Resolves after `ms`, or rejects when aborted. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = () => {
    clearTimeout(timer);
    reject(signal!.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
