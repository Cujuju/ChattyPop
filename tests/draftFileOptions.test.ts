import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { DraftFileInput, SavedDraftFile } from '../src/renderer/src/state/draftFiles';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));
vi.mock('@/api', () => ({ api: { discord: { uploadLimit: async () => 10000 } } }));
vi.mock('@/ui/idbStore', () => ({
  idbEntries: async (prefix: string) => [...stored].filter(([key]) => key.startsWith(prefix)),
  idbSet: (key: string, value: unknown) => value === undefined ? stored.delete(key) : stored.set(key, value),
}));
vi.mock('../src/renderer/src/state/reply', () => ({ restoreReply: () => undefined }));
URL.createObjectURL = () => 'blob:preview';
URL.revokeObjectURL = () => undefined;
const legacy = new File(['old'], 'old.png', { type: 'image/png' });
stored.set('draft-files:legacy', [legacy]);
const modulePath = '../src/renderer/src/state/drafts';
interface Saved { text: string; files: SavedDraftFile[]; emoji: []; reply: null }
interface Drafts {
  attachFiles(channel: string, files: DraftFileInput[]): void;
  draftFiles(channel: string): (SavedDraftFile & { id: number; previewUrl: string | null })[];
  setFileOptions(channel: string, id: number, options: { description: string; spoiler: boolean }): void;
  takeDraft(channel: string, reply: null): Saved;
  restoreDraft(channel: string, saved: Saved): boolean;
}
const drafts = await import(modulePath) as Drafts;
await Promise.resolve();

describe('draft file options', () => {
  it('loads legacy bare Files with default options', () => {
    expect(drafts.draftFiles('legacy')[0]).toMatchObject({ file: legacy, description: '', spoiler: false, previewUrl: 'blob:preview' });
  });

  it('attaches options, persists edits, takes and restores them, and reloads them', async () => {
    const file = new File(['new'], 'bird.png', { type: 'image/png' });
    drafts.attachFiles('new', [{ file, description: 'A bird', spoiler: true }]);
    expect(drafts.draftFiles('new')[0]).toMatchObject({ file, description: 'A bird', spoiler: true });
    const id = drafts.draftFiles('new')[0]!.id;
    drafts.setFileOptions('new', id, { description: 'A blue bird', spoiler: false });
    const saved = drafts.takeDraft('new', null);
    expect(saved.files).toEqual([{ file, description: 'A blue bird', spoiler: false }]);
    expect(drafts.draftFiles('new')).toEqual([]);
    expect(drafts.restoreDraft('new', saved)).toBe(true);
    expect(stored.get('draft-files:new')).toEqual(saved.files);
    // Re-evaluate the store from its IndexedDB records, as a page reload does.
    vi.resetModules();
    const reloaded = await import(modulePath) as Drafts;
    await Promise.resolve();
    expect(reloaded.draftFiles('new')[0]).toMatchObject(saved.files[0]!);
    expect(reloaded.draftFiles('new')[0]!.previewUrl).toBe('blob:preview');
  });

  it('still accepts bare Files from existing callers', () => {
    const file = new File(['text'], 'note.txt');
    drafts.attachFiles('plain', [file]);
    expect(drafts.takeDraft('plain', null).files).toEqual([{ file, description: '', spoiler: false }]);
  });
});
