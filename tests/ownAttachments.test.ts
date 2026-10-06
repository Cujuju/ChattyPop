// Attachment edits retain every remaining attachment, trimmed alt text, and spoiler state. Removing the final content deletes the message.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerEdit, OwnerMessageRef } from '@shared/compose';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const SELF = '900000000000000001';
const sent = vi.hoisted(() => ({ edits: [] as unknown[], deletes: [] as unknown[] }));
vi.mock('virtual:bundled-plugins/shared', async () => (await import('./postingSwitch')).bundledPluginsModule);
vi.mock('../src/renderer/src/state/plugins', async () => (await import('./postingSwitch')).pluginsModule);
vi.mock('@/api', () => ({
  api: {
    discord: {
      edit: async (e: unknown) => void sent.edits.push(e),
      deleteMessage: async (m: unknown) => void sent.deletes.push(m),
    },
  },
}));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined, createPushedValue: () => ({ value: () => SELF }) }));
vi.mock('../src/renderer/src/state/archive', () => ({ archiveChannelId: () => null, archiveState: { items: [] }, openArchive: async () => undefined }));
vi.mock('../src/renderer/src/state/chat', () => ({ chatSource: () => 'archive' }));
vi.mock('../src/renderer/src/state/ui', () => ({ inPanelWindow: false }));

// Renderer module: imported by path so the node type-check doesn't follow it.
const ownAttachmentsPath = '../src/renderer/src/state/ownAttachments';
type Target = { message: ArchiveMessage; attachment: ArchiveAttachment };
const own = (await import(ownAttachmentsPath)) as {
  canChangeAttachment(m: ArchiveMessage, a: ArchiveAttachment): boolean;
  saveAttachment(t: Target, change: { description: string; spoiler: boolean }): Promise<void>;
  confirmDeleteAttachment(t: Target): Promise<void>;
};

const file = (id: string, filename: string, more: Partial<ArchiveAttachment> = {}) => ({ id, filename, description: null, spoiler: false, removed: false, ...more }) as ArchiveAttachment;
const message = (attachments: ArchiveAttachment[], content = '') =>
  ({ id: '500000000000000001', channelId: '300000000000000001', content, stickers: [], attachments, author: { id: SELF }, deletedAt: null, prunedAt: null }) as unknown as ArchiveMessage;
const ref = { channelId: '300000000000000001', messageId: '500000000000000001' };

beforeEach(() => {
  sent.edits = [];
  sent.deletes = [];
});

describe("the owner's attachments", () => {
  const one = file('600000000000000001', 'one.mov');
  const two = file('600000000000000002', 'two.png', { description: 'a chart', spoiler: true });
  const gone = file('600000000000000003', 'gone.png', { removed: true });

  it('Modify names every kept attachment by id, and the modified one with its trimmed alt text and spoiler mark', async () => {
    const m = message([one, two, gone]);
    await own.saveAttachment({ message: m, attachment: one }, { description: '  a clip ', spoiler: true });
    await own.saveAttachment({ message: m, attachment: two }, { description: ' ', spoiler: false });
    expect(sent.edits as OwnerEdit[]).toEqual([
      { ...ref, attachments: [{ id: one.id, change: { description: 'a clip', spoiler: true } }, { id: two.id }] },
      { ...ref, attachments: [{ id: one.id }, { id: two.id, change: { description: '', spoiler: false } }] },
    ]);
  });

  it('Delete keeps the others; the last of a message with nothing else deletes the message', async () => {
    await own.confirmDeleteAttachment({ message: message([one, two, gone]), attachment: one });
    expect(sent.edits as OwnerEdit[]).toEqual([{ ...ref, attachments: [{ id: two.id }] }]);
    await own.confirmDeleteAttachment({ message: message([one, gone]), attachment: one });
    expect(sent.deletes as OwnerMessageRef[]).toEqual([ref]);
    await own.confirmDeleteAttachment({ message: message([one], 'text stays'), attachment: one });
    expect((sent.edits as OwnerEdit[]).at(-1)).toEqual({ ...ref, attachments: [] });
  });

  it('are offered only on the owner’s own attachments still on Discord', () => {
    expect(own.canChangeAttachment(message([one]), one)).toBe(true);
    expect(own.canChangeAttachment(message([gone]), gone)).toBe(false);
    expect(own.canChangeAttachment({ ...message([one]), author: { id: '900000000000000002' } } as ArchiveMessage, one)).toBe(false);
  });
});
