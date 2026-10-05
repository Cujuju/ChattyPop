// Contract (plans/viewer-only-public-host.md §13, phase D): while posting is locked, nothing in a window starts a post. The
// New message window, bot forms and the delete dialog never open, and one open closes when posting locks; a panel
// window's Edit hand-off is ignored. The views' own gates read postingUnlocked() where they draw, so they follow a flip.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveAttachment, ArchiveMessage } from '@shared/contract';
import type { InteractionOutcome } from '@shared/commands';
import { setPostingUnlocked } from './postingSwitch';

// The client runtime, so effects run as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const SELF = '900000000000000001';
const env = vi.hoisted(() => ({ events: new Map<string, (e: unknown) => unknown>(), mine: null as unknown }));
vi.mock('virtual:bundled-plugins/shared', async () => (await import('./postingSwitch')).bundledPluginsModule);
vi.mock('../src/renderer/src/state/plugins', async () => (await import('./postingSwitch')).pluginsModule);
// Stored settings: in memory here.
vi.mock('@plugin-sdk/renderer/settings', () => {
  const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  return { createSetting: <T>(_key: string, initial: T) => createSignal(initial) };
});
vi.mock('@/api', () => ({
  api: {
    core: { ownCommands: async () => [], messageById: async () => env.mine },
    discord: { friends: async () => [] },
  },
}));
vi.mock('@/plugins/slots', () => ({ composerCommands: () => [] }));
vi.mock('../src/renderer/src/state/events', () => ({
  onAppEvent: (type: string, fn: (e: unknown) => unknown) => void env.events.set(type, fn),
  createPushedValue: () => ({ value: () => SELF }),
}));
vi.mock('../src/renderer/src/state/archive', () => ({
  archiveChannelId: () => (env.mine as ArchiveMessage | null)?.channelId ?? null,
  archiveState: { get items() { return env.mine ? [env.mine] : []; } },
  openArchive: async () => undefined,
  openChannel: () => undefined,
  openLive: () => undefined,
}));
vi.mock('../src/renderer/src/state/chat', () => ({ chatSource: () => 'archive' }));
vi.mock('../src/renderer/src/state/composer', () => ({ focusComposer: () => undefined }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined, directory: () => [], refetchDirectory: async () => undefined }));
vi.mock('../src/renderer/src/state/dms', () => ({ dmPerson: () => null, openDmWith: () => undefined, openOneToOnes: () => [] }));
vi.mock('../src/renderer/src/state/localCommands', () => ({ LOCAL_COMMANDS: [] }));
vi.mock('../src/renderer/src/state/ui', () => ({ inPanelWindow: false }));

// Renderer modules: imported by path so the node type-check doesn't follow them.
const newMessagePath = '../src/renderer/src/state/newMessage';
const commandsPath = '../src/renderer/src/state/commands';
const ownMessagesPath = '../src/renderer/src/state/ownMessages';
const ownAttachmentsPath = '../src/renderer/src/state/ownAttachments';
const nm = (await import(newMessagePath)) as { newMessageOpen(): boolean; openNewMessage(): void; openAddFriends(id: string): void; closeNewMessage(): void };
const commands = (await import(commandsPath)) as { botModal(): unknown; followOutcome(o: InteractionOutcome): void; closeBotModal(): void };
const own = (await import(ownMessagesPath)) as {
  deletingMessage(): ArchiveMessage | null;
  deleteMessage(m: ArchiveMessage): void;
  closeDeleteDialog(): void;
  editingId(): string | null;
  cancelEdit(): void;
};
const attachments = (await import(ownAttachmentsPath)) as {
  modifyingAttachment(): unknown;
  deletingAttachment(): unknown;
  modifyAttachment(m: ArchiveMessage, a: ArchiveAttachment): void;
  deleteAttachment(m: ArchiveMessage, a: ArchiveAttachment): void;
  closeModifyAttachment(): void;
  closeDeleteAttachment(): void;
};

const clip = { id: '600000000000000001', filename: 'clip.mov', description: null, removed: false } as unknown as ArchiveAttachment;
const mine = { id: '500000000000000001', channelId: '300000000000000001', content: 'hi', attachments: [clip], author: { id: SELF, name: 'Me' }, deletedAt: null, prunedAt: null } as unknown as ArchiveMessage;
const form = { kind: 'modal', modal: { title: 'Form', fields: [] } } as unknown as InteractionOutcome;
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
const handOverEdit = async (): Promise<void> => {
  await env.events.get('open-message')!({ type: 'open-message', channelId: mine.channelId, messageId: mine.id, compose: 'edit' });
  await settled();
};

beforeEach(() => {
  setPostingUnlocked(true);
  nm.closeNewMessage();
  commands.closeBotModal();
  own.closeDeleteDialog();
  own.cancelEdit();
  attachments.closeModifyAttachment();
  attachments.closeDeleteAttachment();
  env.mine = mine;
});

describe('while posting is locked', () => {
  it('New message opens neither to start a conversation nor to add friends', () => {
    setPostingUnlocked(false);
    nm.openNewMessage();
    nm.openAddFriends('400000000000000002');
    expect(nm.newMessageOpen()).toBe(false);
    setPostingUnlocked(true);
    nm.openNewMessage();
    expect(nm.newMessageOpen()).toBe(true);
  });

  it("a bot's form never opens", () => {
    setPostingUnlocked(false);
    commands.followOutcome(form);
    expect(commands.botModal()).toBeNull();
    setPostingUnlocked(true);
    commands.followOutcome(form);
    expect(commands.botModal()).not.toBeNull();
  });

  it('Delete opens no dialog', () => {
    setPostingUnlocked(false);
    own.deleteMessage(mine);
    expect(own.deletingMessage()).toBeNull();
    setPostingUnlocked(true);
    own.deleteMessage(mine);
    expect(own.deletingMessage()).toBe(mine);
  });

  it("an attachment's Modify and Delete open no dialog", () => {
    setPostingUnlocked(false);
    attachments.modifyAttachment(mine, clip);
    attachments.deleteAttachment(mine, clip);
    expect([attachments.modifyingAttachment(), attachments.deletingAttachment()]).toEqual([null, null]);
    setPostingUnlocked(true);
    attachments.modifyAttachment(mine, clip);
    attachments.deleteAttachment(mine, clip);
    expect([attachments.modifyingAttachment(), attachments.deletingAttachment()]).toEqual([{ message: mine, attachment: clip }, { message: mine, attachment: clip }]);
  });

  it("a panel window's Edit hand-off opens no editor", async () => {
    setPostingUnlocked(false);
    await handOverEdit();
    expect(own.editingId()).toBeNull();
    setPostingUnlocked(true);
    await handOverEdit();
    expect(own.editingId()).toBe(mine.id);
  });
});

describe('when posting locks', () => {
  it('closes an open New message window, bot form and delete dialog', () => {
    nm.openNewMessage();
    commands.followOutcome(form);
    own.deleteMessage(mine);
    attachments.modifyAttachment(mine, clip);
    attachments.deleteAttachment(mine, clip);
    setPostingUnlocked(false);
    expect([attachments.modifyingAttachment(), attachments.deletingAttachment()]).toEqual([null, null]);
    expect(nm.newMessageOpen()).toBe(false);
    expect(commands.botModal()).toBeNull();
    expect(own.deletingMessage()).toBeNull();
    // Unlocking again doesn't bring them back.
    setPostingUnlocked(true);
    expect([nm.newMessageOpen(), commands.botModal(), own.deletingMessage()]).toEqual([false, null, null]);
  });
});

// Views can't be drawn in this node setup: these pin each view's gate to a reactive read of postingUnlocked().
const VIEWS = join(import.meta.dirname, '../src/renderer/src');
const VIEW_GATES: [what: string, file: string, gate: RegExp][] = [
  ["the DMs header's New message", 'panels/channels/Dms.tsx', /<Show when=\{!inCompanion && postingUnlocked\(\)\}>\s*<button[^>]*aria-label="New message"/],
  ['the posting windows and dialogs', 'frame/Overlays.tsx', /<Show when=\{postingUnlocked\(\)\}>\s*<NewMessageWindow \/>\s*<DmDialog \/>\s*<DeleteMessageDialog \/>\s*<ModifyAttachmentDialog \/>\s*<DeleteAttachmentDialog \/>\s*<BotModalWindow \/>\s*<\/Show>/],
  ["a bot message's buttons", 'panels/chat/MessageComponents.tsx', /disabled=\{b\.disabled \|\|[^}]*!postingUnlocked\(\)\}/],
  ["a bot message's menus", 'panels/chat/MessageComponents.tsx', /const disabled = \(\): boolean => s\.disabled \|\|[^;]*!postingUnlocked\(\);/],
  ['swipe to reply', 'panels/chat/MessageRow.tsx', /swipeLeftToAct\(\s*\(\) => startReply\(m\(\)\),\s*\(\) => postingUnlocked\(\) && canReply\(m\(\)\),/],
  ["the Archive's file drop target", 'panels/chat/ArchiveView.tsx', /const dropTarget = \(\) => \(postingUnlocked\(\) \? postable\(\) : undefined\);/],
  ["the profile's Message", 'views/person/ProfileCard.tsx', /<Show when=\{[^}]*&& postingUnlocked\(\)\}>\s*<div class=\{styles\.actions\}>/],
];

describe('the views', () => {
  it.each(VIEW_GATES)('%s (%s)', (_what, file, gate) => {
    expect(readFileSync(join(VIEWS, file), 'utf8')).toMatch(gate);
  });

  it('take files only through the drop target', () => {
    const view = readFileSync(join(VIEWS, 'panels/chat/ArchiveView.tsx'), 'utf8');
    const handlers = view.slice(view.indexOf('onDragOver='), view.indexOf('onDrop=') + view.slice(view.indexOf('onDrop=')).indexOf('}}'));
    expect(handlers).not.toMatch(/postable\(\)/);
    expect(handlers.match(/dropTarget\(\)/g)).toHaveLength(2);
  });
});
