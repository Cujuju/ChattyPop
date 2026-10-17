import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

const env = vi.hoisted(() => ({ listeners: new Set<(e: AppEvent) => void>(), save: vi.fn(), reveal: vi.fn(), drag: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ api: {
  media: { saveAttachmentsToFolder: env.save, showAttachmentFolder: env.reveal, startFileDrag: env.drag },
  onEvent: (listener: (e: AppEvent) => void) => { env.listeners.add(listener); return () => env.listeners.delete(listener); },
} }));
vi.mock('../src/renderer/src/state/ui', () => ({ onServerScreen: true }));
const EXPORTS_MODULE = '../src/renderer/src/state/attachmentExports';
const { saveAttachmentsToFolder, startFileDrag } = await import(EXPORTS_MODULE);
const FILE = { id: '1', sha256: 'a'.repeat(64), filename: 'photo.png', storedExt: null, status: 'stored', contentType: 'image/png', animated: false, compressed: false };
beforeEach(() => { vi.clearAllMocks(); env.listeners.clear(); });

describe('renderer folder exports', () => {
  it('isolates concurrent progress subscriptions and disposes each when its own export settles', async () => {
    const finish: ((value: null) => void)[] = [];
    env.save.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    const first = vi.fn(); const second = vi.fn();
    const a = saveAttachmentsToFolder([FILE], first); const b = saveAttachmentsToFolder([FILE], second);
    const requestId = env.save.mock.calls[0]![1] as string;
    expect(env.save.mock.calls[1]![1]).not.toBe(requestId);
    for (const listener of env.listeners) listener({ type: 'attachment-save-progress', requestId, done: 1, total: 2 });
    expect(first).toHaveBeenCalledWith({ done: 1, total: 2 });
    expect(second).not.toHaveBeenCalled();
    finish[0]!(null); expect(await a).toBeNull(); expect(env.listeners.size).toBe(1);
    finish[1]!(null); await b; expect(env.listeners.size).toBe(0);
  });

  it('cleans up after a rejected export and refuses unstored references for save and drag', async () => {
    env.save.mockRejectedValue(new Error('disk'));
    await expect(saveAttachmentsToFolder([FILE])).rejects.toThrow('disk');
    expect(env.listeners.size).toBe(0);
    await expect(saveAttachmentsToFolder([{ ...FILE, status: 'evicted' }])).rejects.toThrow(/archived attachment/);
    await expect(startFileDrag({ ...FILE, status: 'evicted' })).rejects.toThrow(/stored attachment/);
    expect(env.save).toHaveBeenCalledTimes(1); expect(env.drag).not.toHaveBeenCalled();
  });
});
