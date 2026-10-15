// Drafts kept before a reload come back, unless the draft was changed (typed, attached, sent) while they were read.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

/** IndexedDB's scans, answered when the test says. */
const scans = new Map<string, (entries: [string, unknown][]) => void>();
vi.mock('@/api', () => ({ api: { discord: { uploadLimit: async () => Number.MAX_SAFE_INTEGER, typing: async () => undefined } } }));
vi.mock('@/ui/idbStore', () => ({
  idbEntries: (prefix: string) => new Promise((resolve) => scans.set(prefix, resolve)),
  idbSet: () => undefined,
}));
vi.mock('../src/renderer/src/state/reply', () => ({ restoreReply: () => undefined }));
URL.createObjectURL = () => 'blob:x';

// A variable path keeps the renderer module (its `@/` imports) out of the node type-check.
const DRAFTS = '../src/renderer/src/state/drafts';
interface Drafts {
  setDraftText(channelId: string, text: string): void;
  attachFiles(channelId: string, files: File[]): void;
  removeFile(channelId: string, id: number): void;
  takeDraft(channelId: string, reply: null): { text: string; files: unknown[] };
  draftText(channelId: string): string;
  draftFiles(channelId: string): { id: number; file: File }[];
}
const C = '100000000000000001';
const OLD_TEXT = { text: 'old saved text', emoji: [], mentions: [] };
const oldFile = (): { file: File } => ({ file: new File(['old'], 'old.txt', { type: 'text/plain' }) });

/** Answers both scans: the text scan with `texts`, the files scan with `files`. */
async function answerScans(texts: [string, unknown][], files: [string, unknown][]): Promise<void> {
  scans.get('draft-text:')!(texts);
  scans.get('draft-files:')!(files);
  await new Promise((done) => setImmediate(done));
}

beforeEach(() => {
  scans.clear();
  vi.resetModules();
});

describe('restoring saved drafts', () => {
  it('brings back text and files when nothing changed meanwhile', async () => {
    const d = (await import(DRAFTS)) as Drafts;
    await answerScans([[`draft-text:${C}`, OLD_TEXT]], [[`draft-files:${C}`, [oldFile()]]]);
    expect(d.draftText(C)).toBe('old saved text');
    expect(d.draftFiles(C).map((f) => f.file.name)).toEqual(['old.txt']);
  });

  it('never brings back text after a newer draft was typed and sent', async () => {
    const d = (await import(DRAFTS)) as Drafts;
    d.setDraftText(C, 'freshly typed');
    expect(d.takeDraft(C, null).text).toBe('freshly typed');
    await answerScans([[`draft-text:${C}`, OLD_TEXT]], []);
    expect(d.draftText(C)).toBe('');
  });

  it('never brings back files after newer files were attached and sent', async () => {
    const d = (await import(DRAFTS)) as Drafts;
    d.attachFiles(C, [new File(['new'], 'new.txt', { type: 'text/plain' })]);
    expect(d.takeDraft(C, null).files).toHaveLength(1);
    await answerScans([], [[`draft-files:${C}`, [oldFile()]]]);
    expect(d.draftFiles(C)).toEqual([]);
  });

  it('never brings back files after the draft’s files were removed', async () => {
    const d = (await import(DRAFTS)) as Drafts;
    d.attachFiles(C, [new File(['new'], 'new.txt', { type: 'text/plain' })]);
    d.removeFile(C, d.draftFiles(C)[0]!.id);
    await answerScans([], [[`draft-files:${C}`, [oldFile()]]]);
    expect(d.draftFiles(C)).toEqual([]);
  });

  it('brings back text without waiting for the files scan', async () => {
    const d = (await import(DRAFTS)) as Drafts;
    scans.get('draft-text:')!([[`draft-text:${C}`, OLD_TEXT]]);
    await new Promise((done) => setImmediate(done));
    expect(d.draftText(C)).toBe('old saved text');
  });
});
