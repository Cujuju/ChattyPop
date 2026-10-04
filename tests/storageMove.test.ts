import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { tempDir } from './helpers';

/** What the mocked system dialogs answer, and what they were shown. */
const ui = vi.hoisted(() => ({ userData: '', pick: '', confirm: 0, shown: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => ui.userData },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [ui.pick] }),
    showMessageBox: async (_w: unknown, o: { message: string; detail?: string }) => {
      ui.shown.push(`${o.message}: ${o.detail ?? ''}`);
      return { response: ui.confirm };
    },
  },
}));

const { deletePreviousArchive, moveArchive, storageInfo, verifyMovedArchive } = await import('../src/main/storageMove');
const { saveStorageConfig, storageConfig } = await import('../src/main/storageLocation');

const win = {} as Electron.BrowserWindow;
let from: string;
let events: string[];
let restarts: number;
const hooks = {
  stop: async () => {},
  emit: (e: AppEvent) => void events.push(e.type === 'storage-move' ? e.phase : e.type),
  restart: () => void restarts++,
};

beforeEach(() => {
  ui.userData = tempDir();
  ui.shown = [];
  ui.confirm = 0;
  events = [];
  restarts = 0;
  from = tempDir();
  mkdirSync(join(from, 'media', 'attachments', 'ab'), { recursive: true });
  mkdirSync(join(from, 'Profile'));
  writeFileSync(join(from, 'archive.db'), 'x'.repeat(5000));
  writeFileSync(join(from, 'archive.db-wal'), '');
  writeFileSync(join(from, 'media', 'attachments', 'ab', 'abc.png'), 'png');
  writeFileSync(join(from, 'media', 'attachments', '.part-1-2'), 'partial download');
  writeFileSync(join(from, 'Profile', 'Cookies'), 'not archive data');
  saveStorageConfig({ archiveDir: from });
});

describe('moving the archive', () => {
  it('refuses a folder inside the archive, or one that already holds an archive', async () => {
    ui.pick = join(from, 'media');
    await moveArchive(win, hooks);
    const taken = tempDir();
    writeFileSync(join(taken, 'archive.db'), '');
    ui.pick = taken;
    await moveArchive(win, hooks);
    expect(ui.shown).toEqual([expect.stringMatching(/outside the current archive/), expect.stringMatching(/already holds/)]);
    expect(events).toEqual([]);
  });

  it('copies only archive files, verifies, switches and restarts', async () => {
    ui.pick = tempDir();
    await moveArchive(win, hooks);
    expect(events).toEqual(['stopping', 'copying', 'verifying', 'restarting']);
    expect(restarts).toBe(1);
    expect(storageConfig()).toEqual({ archiveDir: ui.pick, previousDir: from, verifyOnOpen: true });
    expect(readdirSync(ui.pick, { recursive: true }).map(String).sort()).toEqual(
      [
        'archive.db',
        'archive.db-wal',
        'media',
        join('media', 'attachments'),
        join('media', 'attachments', 'ab'),
        join('media', 'attachments', 'ab', 'abc.png'),
      ].sort(),
    );
    expect(storageInfo().previousDir).toBeNull(); // not offered for deletion until verified
  });

  it('keeps the copy after a passing check, and reverts after a failing one', async () => {
    const to = tempDir();
    saveStorageConfig({ archiveDir: to, previousDir: from, verifyOnOpen: true });
    const core = (answer: string) => ({ call: async () => answer }) as unknown as Parameters<typeof verifyMovedArchive>[1];
    await verifyMovedArchive(win, core('ok'), hooks.restart);
    expect(storageConfig()).toEqual({ archiveDir: to, previousDir: from });

    saveStorageConfig({ archiveDir: to, previousDir: from, verifyOnOpen: true });
    await verifyMovedArchive(win, core('row 5 missing from index'), hooks.restart);
    expect(storageConfig()).toEqual({ archiveDir: from });
    expect(restarts).toBe(1);
  });

  it('deletes the previous copy only after confirmation, and only its archive files', async () => {
    saveStorageConfig({ archiveDir: tempDir(), previousDir: from });
    ui.confirm = 1; // Cancel
    await deletePreviousArchive(win);
    expect(existsSync(join(from, 'archive.db'))).toBe(true);
    ui.confirm = 0; // Delete
    await deletePreviousArchive(win);
    expect(existsSync(join(from, 'archive.db'))).toBe(false);
    expect(existsSync(join(from, 'media'))).toBe(false);
    expect(existsSync(join(from, 'Profile', 'Cookies'))).toBe(true);
    expect(storageConfig().previousDir).toBeUndefined();
  });
});
