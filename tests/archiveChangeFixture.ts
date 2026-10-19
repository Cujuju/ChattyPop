import type { ArchiveChange, ArchiveChangeKind } from '@shared/contract';
import { changeSet, matchingChange, type ArchiveChangeSet, type ArchiveDeps } from '../src/plugin-sdk/renderer/archiveChangeSet';

export const archiveChange = (channelId: string, kinds: ArchiveChangeKind[] = ['messages'], insertOnly = false): ArchiveChange => ({
  changes: { [channelId]: kinds }, insertOnlyChannelIds: insertOnly ? [channelId] : [],
});
export const archiveListener = (deps: ArchiveDeps, fn: (c: ArchiveChangeSet, signal: AbortSignal) => unknown) => (e: ArchiveChange): unknown => {
  const match = matchingChange(e, deps, () => undefined);
  if (Object.keys(match.changes).length) return fn(changeSet(match), new AbortController().signal);
};
