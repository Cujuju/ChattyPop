// The draft stash: setting a channel's draft aside and bringing it back, swapping with what the box holds, reply included.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

/** IndexedDB's scans, answered when the test says; writes, by key. */
const scans = new Map<string, (entries: [string, unknown][]) => void>();
const written = new Map<string, unknown>();
vi.mock('@/api', () => ({ api: { discord: { uploadLimit: async () => Number.MAX_SAFE_INTEGER, typing: async () => undefined } } }));
vi.mock('@/ui/idbStore', () => ({
  idbEntries: (prefix: string) => new Promise((resolve) => scans.set(prefix, resolve)),
  idbSet: (key: string, value: unknown) => void written.set(key, value),
}));
/** The one open reply, as reply.ts keeps it. */
const reply = vi.hoisted(() => ({ target: null as { id: string; channelId: string } | null }));
vi.mock('../src/renderer/src/state/reply', () => ({
  replyTarget: () => reply.target,
  cancelReply: () => void (reply.target = null),
  restoreReply: (m: { id: string; channelId: string }) => void (reply.target ??= m),
}));
URL.createObjectURL = () => 'blob:x';

// Variable paths keep the renderer modules (their `@/` imports) out of the node type-check.
const DRAFTS = '../src/renderer/src/state/drafts';
const STASH = '../src/renderer/src/state/draftStash';
interface Drafts {
  setDraftText(channelId: string, text: string): void;
  attachFiles(channelId: string, files: File[]): void;
  draftText(channelId: string): string;
  draftFiles(channelId: string): { file: File }[];
}
interface Stash {
  stashDraft(channelId: string): boolean;
  stashedDrafts(channelId: string): readonly { text: string; reply: { id: string } | null }[];
  unstashDraft(channelId: string, index: number): void;
  dropStashedDraft(channelId: string, index: number): void;
}
const C = '100000000000000001';
const OTHER = '100000000000000002';
const KEY = `draft-stash:${C}`;
const saved = (text: string) => ({ text, files: [], emoji: [], mentions: [], reply: null });

async function load(): Promise<{ d: Drafts; s: Stash }> {
  const d = (await import(DRAFTS)) as Drafts;
  const s = (await import(STASH)) as Stash;
  return { d, s };
}
const texts = (s: Stash): string[] => s.stashedDrafts(C).map((x) => x.text);

beforeEach(() => {
  scans.clear();
  written.clear();
  reply.target = null;
  vi.resetModules();
});

describe('the draft stash', () => {
  it('sets the draft aside, files included, and brings it back into an empty box', async () => {
    const { d, s } = await load();
    d.setDraftText(C, 'half written');
    d.attachFiles(C, [new File(['a'], 'a.txt', { type: 'text/plain' })]);
    expect(s.stashDraft(C)).toBe(true);
    expect(d.draftText(C)).toBe('');
    expect(d.draftFiles(C)).toEqual([]);
    expect(texts(s)).toEqual(['half written']);
    s.unstashDraft(C, 0);
    expect(d.draftText(C)).toBe('half written');
    expect(d.draftFiles(C).map((f) => f.file.name)).toEqual(['a.txt']);
    expect(s.stashedDrafts(C)).toEqual([]);
    expect(written.get(KEY)).toBeUndefined();
  });

  it('has nothing to stash in an empty box', async () => {
    const { s } = await load();
    expect(s.stashDraft(C)).toBe(false);
    expect(s.stashedDrafts(C)).toEqual([]);
  });

  it('keeps the newest first and swaps the box’s draft into the stash on restore', async () => {
    const { d, s } = await load();
    d.setDraftText(C, 'first');
    s.stashDraft(C);
    d.setDraftText(C, 'second');
    s.stashDraft(C);
    d.setDraftText(C, 'typing now');
    s.unstashDraft(C, 1);
    expect(d.draftText(C)).toBe('first');
    expect(texts(s)).toEqual(['typing now', 'second']);
    expect((written.get(KEY) as { text: string }[]).map((x) => x.text)).toEqual(['typing now', 'second']);
  });

  it('throws one stashed draft away, leaving the box and the rest', async () => {
    const { d, s } = await load();
    d.setDraftText(C, 'first');
    s.stashDraft(C);
    d.setDraftText(C, 'second');
    s.stashDraft(C);
    d.setDraftText(C, 'typing now');
    s.dropStashedDraft(C, 0);
    expect(d.draftText(C)).toBe('typing now');
    expect(texts(s)).toEqual(['first']);
    expect((written.get(KEY) as { text: string }[]).map((x) => x.text)).toEqual(['first']);
    s.dropStashedDraft(C, 0);
    expect(s.stashedDrafts(C)).toEqual([]);
    expect(written.get(KEY)).toBeUndefined();
  });

  it('carries the reply: stashing closes it, restoring opens it again over another', async () => {
    const { d, s } = await load();
    reply.target = { id: 'm1', channelId: C };
    d.setDraftText(C, 'answer');
    s.stashDraft(C);
    expect(reply.target).toBeNull();
    expect(s.stashedDrafts(C)[0]!.reply?.id).toBe('m1');
    reply.target = { id: 'm2', channelId: OTHER };
    s.unstashDraft(C, 0);
    expect(reply.target).toEqual({ id: 'm1', channelId: C });
  });

  it('leaves another channel’s reply out of the stash', async () => {
    const { d, s } = await load();
    reply.target = { id: 'm2', channelId: OTHER };
    d.setDraftText(C, 'unrelated');
    s.stashDraft(C);
    expect(s.stashedDrafts(C)[0]!.reply).toBeNull();
    expect(reply.target).toEqual({ id: 'm2', channelId: OTHER });
  });

  it('brings back stashes kept before a reload, after one stashed while they loaded', async () => {
    const { d, s } = await load();
    d.setDraftText(C, 'stashed while loading');
    s.stashDraft(C);
    scans.get('draft-stash:')!([[KEY, [saved('kept before')]]]);
    await new Promise((done) => setImmediate(done));
    expect(texts(s)).toEqual(['stashed while loading', 'kept before']);
    expect((written.get(KEY) as { text: string }[]).map((x) => x.text)).toEqual(['stashed while loading', 'kept before']);
  });
});
