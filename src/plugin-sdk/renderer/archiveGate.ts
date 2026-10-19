import { ArchiveChanges, changeSet, matchingChange, type ArchiveChangeSet, type ArchiveDeps } from './archiveChangeSet';
import type { ArchiveChange } from '@shared/contract';

export interface ArchiveGate {
  accept(change: ArchiveChange): void;
  visibilityChanged(): void;
  dispose(): void;
}

/** One debounce, one flight, and one pending merged rerun; hidden views retain invalidations without executing reads. */
export function createArchiveGate(
  deps: ArchiveDeps,
  run: (change: ArchiveChangeSet, signal: AbortSignal) => unknown,
  guildOf: (channelId: string) => string | undefined,
  delay: number,
  report: (error: unknown) => void,
): ArchiveGate {
  const pending = new ArchiveChanges();
  let dirty = false;
  let live = true;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let running: ArchiveChange | undefined;
  const shown = (): boolean => deps.shown?.() ?? true;
  const flush = (): void => {
    timer = undefined;
    if (!live || !dirty || busy || !shown()) return;
    dirty = false;
    busy = true;
    const change = matchingChange(pending.take(), deps, guildOf);
    if (!Object.keys(change.changes).length) { busy = false; return; }
    running = change;
    const mine = new AbortController();
    controller = mine;
    let result: unknown;
    try { result = run(changeSet(change), mine.signal); } catch (error) { report(error); }
    Promise.resolve(result).catch((error) => { if (!mine.signal.aborted) report(error); }).finally(() => {
      busy = false;
      controller = undefined;
      running = undefined;
      if (live && dirty && timer === undefined) flush();
    });
  };
  const accept = (change: ArchiveChange): void => {
    if (!live) return;
    const match = matchingChange(change, deps, guildOf);
    if (!Object.keys(match.changes).length) return;
    pending.merge(match);
    dirty = true;
    // An aborted read might not have answered its changes; its replacement must answer them as well.
    if (running) pending.merge(running);
    controller?.abort();
    clearTimeout(timer);
    timer = shown() ? setTimeout(flush, delay) : undefined;
  };
  const visibilityChanged = (): void => {
    if (!live) return;
    if (!shown()) {
      clearTimeout(timer);
      timer = undefined;
      if (running) { pending.merge(running); dirty = true; controller?.abort(); }
    } else if (dirty) {
      clearTimeout(timer);
      timer = undefined;
      flush();
    }
  };
  return { accept, visibilityChanged, dispose: () => {
    live = false;
    clearTimeout(timer);
    controller?.abort();
  } };
}
