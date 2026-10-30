import { createRequire } from 'node:module';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SavedDraftFile, DraftFileInput } from '../src/renderer/src/state/draftFiles';
import { UPLOAD_GONE } from '@shared/compose';
import { acceptedMessage } from './postedMessageFixture';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const env = vi.hoisted(() => ({
  unlocked: true, account: 'owner', count: 0,
  prepareUploads: vi.fn(), uploadChunk: vi.fn(), finishUpload: vi.fn(), send: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@/api', () => ({ api: { discord: {
  uploadLimit: async () => 10000,
  prepareUploads: env.prepareUploads, uploadChunk: env.uploadChunk, finishUpload: env.finishUpload, send: env.send,
} } }));
vi.mock('@/ui/idbStore', () => ({ idbEntries: async () => [], idbSet: () => undefined, whenWritten: async () => undefined }));
vi.mock('@/ui/format', () => ({ errorText: String }));
vi.mock('../src/renderer/src/state/ownMessages', () => ({ selfId: () => env.account }));
vi.mock('../src/renderer/src/state/posting', () => ({ postingUnlocked: () => env.unlocked }));
vi.mock('../src/renderer/src/state/reply', () => ({ restoreReply: () => undefined }));
vi.mock('../src/renderer/src/state/uploadPrep', () => ({ prepareFiles: env.prepare }));
vi.mock('../src/renderer/src/state/outboxSent', () => ({ sentRows: { accept: () => undefined, hasArchived: () => false } }));
vi.stubGlobal('navigator', {});
vi.stubGlobal('window', { addEventListener: () => undefined });
URL.createObjectURL = () => 'blob:preview';
URL.revokeObjectURL = () => undefined;
const draftsPath = '../src/renderer/src/state/drafts';
const outboxPath = '../src/renderer/src/state/outbox';
interface Draft { text: string; files: SavedDraftFile[]; emoji: []; reply: null }
const drafts = await import(draftsPath) as {
  attachFiles(channel: string, files: DraftFileInput[]): void;
  attachLongPaste(channel: string, event: unknown, field: unknown): boolean;
  draftFiles(channel: string): (SavedDraftFile & { id: number })[];
  draftError(channel: string): string | null;
  takeDraft(channel: string, reply: null, sending?: boolean): Draft;
  snapshotDraft(channel: string, reply: null): Draft;
  restoreDraft(channel: string, draft: Draft): boolean;
  removeFile(channel: string, id: number): void;
  setFileOptions(channel: string, id: number, options: { description: string; spoiler: boolean }): void;
};
// Renderer imports use variable paths to keep the node type-check outside the renderer graph.
const box = await import(outboxPath) as {
  enqueue(job: import('../src/renderer/src/state/outboxQueue').OutboxJob<unknown>): void;
  outgoing(channelId: string): { phase: string | null; progress: number | null; status: string }[];
};
let channel = 0;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
function attach() {
  const id = `channel-${channel++}`;
  drafts.attachFiles(id, [new File(['bytes'], 'first.txt')]);
  return id;
}
function send(id: string) {
  const draft = drafts.takeDraft(id, null, true);
  box.enqueue({ channelId: id, label: '', message: { channelId: id, accountId: env.account, nonce: id, text: '', files: [], replyTo: null, stickerId: null, gif: null }, files: draft.files, mentions: {}, draft });
}
beforeEach(() => {
  vi.clearAllMocks();
  env.unlocked = true;
  env.account = 'owner';
  env.count = 0;
  env.prepare.mockImplementation(async (files: File[]) => files);
  env.prepareUploads.mockImplementation(async (_c, files) => files.map(() => ({ token: `t${++env.count}` })));
  env.uploadChunk.mockResolvedValue(undefined);
  env.finishUpload.mockResolvedValue(undefined);
  env.send.mockImplementation(async (m) => acceptedMessage(m));
});

it('reuses a finished upload without preparing another slot', async () => {
  const id = attach();
  await settle();
  expect(env.finishUpload).toHaveBeenCalledWith('t1');
  send(id);
  await settle();
  expect(env.prepareUploads).toHaveBeenCalledTimes(1);
  expect(env.prepare).toHaveBeenCalledTimes(1);
  expect(env.prepareUploads.mock.calls[0]![2]).toBe('owner');
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t1']);
});

it('waits for an in-flight upload and forwards its progress', async () => {
  const gate = deferred();
  env.uploadChunk.mockReturnValueOnce(gate.promise);
  const id = attach();
  await settle();
  send(id);
  await settle();
  expect(env.send).not.toHaveBeenCalled();
  expect(box.outgoing(id)[0]!.phase).toBe('uploading');
  gate.resolve();
  await settle();
  expect(env.prepareUploads).toHaveBeenCalledTimes(1);
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t1']);
});

it.each(['options', 'removal', 'clear', 'failure'] as const)('falls back after %s', async (reason) => {
  if (reason === 'failure') env.finishUpload.mockRejectedValueOnce(new Error('offline'));
  const id = attach();
  await settle();
  const file = drafts.draftFiles(id)[0]!;
  if (reason === 'options') {
    drafts.setFileOptions(id, file.id, { description: 'changed', spoiler: true });
    drafts.setFileOptions(id, file.id, { description: '', spoiler: false });
  }
  if (reason === 'removal' || reason === 'clear') {
    const snapshot = drafts.snapshotDraft(id, null);
    if (reason === 'removal') drafts.removeFile(id, file.id);
    else drafts.takeDraft(id, null);
    drafts.restoreDraft(id, snapshot);
  }
  expect(drafts.draftError(id)).toBeNull();
  send(id);
  await settle();
  expect(env.prepareUploads).toHaveBeenCalledTimes(2);
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t2']);
});

it('keeps file order with mixed early and send-time uploads', async () => {
  const id = attach();
  await settle();
  env.unlocked = false;
  drafts.attachFiles(id, [new File(['second'], 'second.txt')]);
  env.unlocked = true;
  drafts.attachFiles(id, [new File(['third'], 'third.txt')]);
  await settle();
  send(id);
  await settle();
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t1', 't3', 't2']);
});

it.each(['account', 'channel'] as const)('rejects an upload for another %s', async (reason) => {
  const id = attach();
  await settle();
  if (reason === 'account') env.account = 'another';
  const draft = drafts.takeDraft(id, null, true);
  const target = reason === 'channel' ? `channel-${channel++}` : id;
  box.enqueue({ channelId: target, label: '', message: { channelId: target, accountId: env.account, nonce: target, text: '', files: [], replyTo: null, stickerId: null, gif: null }, files: draft.files, mentions: {}, draft });
  await settle();
  expect(env.prepareUploads).toHaveBeenCalledTimes(2);
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t2']);
});

it('re-uploads an expired early token on UPLOAD_GONE', async () => {
  const id = attach();
  await settle();
  env.send.mockRejectedValueOnce(new Error(UPLOAD_GONE));
  send(id);
  await settle();
  expect(env.prepareUploads).toHaveBeenCalledTimes(2);
  expect(env.send.mock.calls.map(([m]) => m.uploads)).toEqual([['t1'], ['t2']]);
  expect(box.outgoing(id)).toEqual([]);
});

it('starts an upload for long-paste files', async () => {
  const id = `channel-${channel++}`;
  drafts.attachLongPaste(id, { clipboardData: { files: [], getData: () => 'x'.repeat(5000) }, preventDefault: () => undefined },
    { value: '', selectionStart: 0, selectionEnd: 0 });
  await settle();
  expect(env.prepareUploads.mock.calls[0]![1][0].name).toBe('message.txt');
});

it('skips uploads while locked and uploads restored files at send', async () => {
  env.unlocked = false;
  const id = attach();
  await settle();
  expect(env.prepareUploads).not.toHaveBeenCalled();
  const saved = drafts.takeDraft(id, null);
  drafts.restoreDraft(id, { ...saved, files: saved.files.map((f) => ({ ...f })) });
  env.unlocked = true;
  send(id);
  await settle();
  expect(env.send.mock.calls[0]![0].uploads).toEqual(['t1']);
});

it('uses prepared bytes and attachment options for the early slot', async () => {
  const prepared = new File(['small'], 'encoded.mp4');
  env.prepare.mockResolvedValueOnce([prepared]);
  const id = `channel-${channel++}`;
  drafts.attachFiles(id, [{ file: new File(['original'], 'original.mov'), description: 'clip', spoiler: true }]);
  await settle();
  expect(env.prepareUploads.mock.calls[0]![1]).toEqual([{ name: 'encoded.mp4', size: prepared.size, description: 'clip', spoiler: true }]);
  send(id);
  await settle();
  expect(env.prepare).toHaveBeenCalledTimes(1);
  expect(env.prepareUploads).toHaveBeenCalledTimes(1);
});

it('abandons an upload removed while preparation is pending', async () => {
  const gate = deferred();
  env.prepare.mockImplementationOnce(async (files: File[]) => { await gate.promise; return files; });
  const id = attach();
  const file = drafts.draftFiles(id)[0]!;
  drafts.removeFile(id, file.id);
  gate.resolve();
  await settle();
  expect(env.prepareUploads).not.toHaveBeenCalled();
});
