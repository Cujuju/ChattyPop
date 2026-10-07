// Attaching is immediate, so a send right after keeps the files with their text; the channel's upload limit, once heard,
// turns away oversized files (videos excepted: sending shrinks them).
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { BYTES_PER_MB } from '@shared/units';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const LIMIT = 10 * BYTES_PER_MB;
vi.mock('@/api', () => ({ api: { discord: { uploadLimit: async () => LIMIT } } }));
vi.mock('@/ui/idbStore', () => ({ idbEntries: async () => [], idbSet: () => undefined }));
vi.mock('../src/renderer/src/state/reply', () => ({ restoreReply: () => undefined }));
URL.createObjectURL = () => 'blob:x';

// A variable path keeps the renderer module (its `@/` imports) out of the node type-check.
const draftsPath = '../src/renderer/src/state/drafts';
const { attachFiles, draftError, draftFiles } = (await import(draftsPath)) as {
  attachFiles(channelId: string, files: File[]): void;
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
