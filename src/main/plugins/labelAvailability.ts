// Publish complete live-label availability snapshots; retain the previous one during refresh.
/** Only the newest requested snapshot may replace the live labels; a refresh resolves once it and those before it settled. */
export function labelRefresher<T>(load: () => Promise<T>, publish: (value: T) => void, failed: (error: unknown) => void): () => Promise<void> {
  let generation = 0;
  let pending = Promise.resolve();
  return () => {
    const requested = ++generation;
    pending = pending.then(async () => {
      const value = await load();
      if (requested === generation) publish(value);
    }).catch(failed);
    return pending;
  };
}
