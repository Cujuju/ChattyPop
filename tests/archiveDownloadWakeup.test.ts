import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ArchiveChangeKind } from '@shared/contract';
import { routeCoreEvents } from '../src/main/coreEvents';

vi.mock('../src/main/desktopNotifications', () => ({ notifyDesktop: () => {} }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => {} }));

it('wakes media queues for custom-emoji sources as well as attachments, without waking on unrelated changes', () => {
  const core = new EventEmitter();
  const kick = vi.fn();
  routeCoreEvents({
    core, downloader: { kick }, win: { isDestroyed: () => false, webContents: { send: () => {} } },
    panelWindows: { windows: () => [] }, phone: { broadcast: () => {}, notify: () => {} }, desktopNotices: false,
  } as unknown as Parameters<typeof routeCoreEvents>[0]);
  const send = (kind: ArchiveChangeKind) => core.emit('event', { type: 'archive-changed', changes: { c: [kind] }, insertOnlyChannelIds: [] });
  for (const kind of ['disk', 'names', 'channels', 'polls', 'plugin'] as const) send(kind);
  expect(kick).not.toHaveBeenCalled();
  for (const kind of ['messages', 'edits', 'reactions', 'attachments'] as const) {
    kick.mockClear(); send(kind); expect(kick).toHaveBeenCalledOnce();
  }
});
