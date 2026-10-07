// Attaching is immediate, so a send right after keeps the files with their text; the channel's upload limit, once heard,
// turns away oversized files (videos excepted: sending shrinks them).
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { DISCORD_TEXT_MAX } from '@shared/discord';
import { BYTES_PER_MB } from '@shared/units';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const LIMIT = 10 * BYTES_PER_MB;
vi.mock('@/api', () => ({ api: { discord: { uploadLimit: async () => LIMIT } } }));
vi.mock('@/ui/idbStore', () => ({ idbEntries: async () => [], idbSet: () => undefined }));
vi.mock('../src/renderer/src/state/reply', () => ({ restoreReply: () => undefined }));
URL.createObjectURL = () => 'blob:x';

// A variable path keeps the renderer module (its `@/` imports) out of the node type-check.
const draftsPath = '../src/renderer/src/state/drafts';
const { attachFiles, attachLongPaste, draftError, draftFiles } = (await import(draftsPath)) as {
  attachFiles(channelId: string, files: File[]): void;
  attachLongPaste(channelId: string, e: unknown): boolean;
  draftError(channelId: string): string | null;
  draftFiles(channelId: string): { file: File }[];
};
const CHANNEL = '100000000000000001';
const sized = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type });

describe('attachFiles', () => {
  it('attaches at once, then holds files to the channel’s limit', async () => {
    const big = sized('big.png', 'image/png', LIMIT + 1);
    attachFiles(CHANNEL, [big]);
    expect(draftFiles(CHANNEL).map((f) => f.file)).toEqual([big]);
    await Promise.resolve();
    attachFiles(CHANNEL, [sized('big2.png', 'image/png', LIMIT + 1), sized('long.mp4', 'video/mp4', LIMIT + 1)]);
    expect(draftFiles(CHANNEL).map((f) => f.file.name)).toEqual(['big.png', 'long.mp4']);
    expect(draftError(CHANNEL)).toMatch(/up to 10 MB/);
  });
});

describe('attachLongPaste', () => {
  const PASTE_CHANNEL = '100000000000000002';
  /** A paste of `text` into a field holding `value`, its selection [start, end). */
  const paste = (text: string, value = '', start = value.length, end = start) => {
    let prevented = false;
    const e = {
      clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? text : '') },
      currentTarget: { value, selectionStart: start, selectionEnd: end },
      preventDefault: () => (prevented = true),
    };
    return { took: attachLongPaste(PASTE_CHANNEL, e), prevented: () => prevented };
  };

  it('leaves a paste that fits the field to the field', () => {
    const r = paste('x'.repeat(DISCORD_TEXT_MAX - 10), 'y'.repeat(10));
    expect(r.took).toBe(false);
    expect(r.prevented()).toBe(false);
    expect(draftFiles(PASTE_CHANNEL)).toEqual([]);
  });

  it('counts the selection it replaces', () => {
    expect(paste('x'.repeat(DISCORD_TEXT_MAX), 'selected', 0, 'selected'.length).took).toBe(false);
  });

  it('attaches a paste that would overflow the field as message.txt, whole', async () => {
    const text = 'z'.repeat(DISCORD_TEXT_MAX + 1);
    const r = paste(text);
    expect(r.took).toBe(true);
    expect(r.prevented()).toBe(true);
    const f = draftFiles(PASTE_CHANNEL)[0]!.file;
    expect([f.name, f.type]).toEqual(['message.txt', 'text/plain']);
    expect(await f.text()).toBe(text);
  });
});
