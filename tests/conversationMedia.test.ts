import { beforeAll, describe, expect, it } from 'vitest';
import type { ArchiveAttachment, ConversationView } from '@shared/contract';
import { postedArchiveMessage } from '@shared/postedMessage';
import { acceptedMessage } from './postedMessageFixture';
import { buildContainment, CONTAINMENT_ADAPTER } from './containmentBuild';
import type { TestNode } from './sectionSplitHarness';

interface Mounted {
  root: TestNode;
  snapshot(): ConversationView;
  refresh(next: ConversationView): Promise<void>;
  dispose(): void;
}
let client: { mount(view: ConversationView): Mounted };
const SOURCE = `
  import { For } from 'solid-js';
  import { node, render } from '${CONTAINMENT_ADAPTER}';
  import { Attachments } from '@/panels/chat/Attachments';
  import { conversation, openConversation, closeConversation } from '@/state/conversation';
  import { keyedRows } from '@/ui/keyedRows';
  import { environment } from '@/api';

  export function mount(view) {
    environment.view = view;
    openConversation(view.rootId);
    const root = node('root');
    const dispose = render(() => {
      const rows = keyedRows(() => conversation()?.messages ?? []);
      return <For each={rows.ids()}>{(id) => <Attachments message={rows.item(id)} messageLink="" />}</For>;
    }, root);
    return {
      root,
      snapshot: conversation,
      refresh(next) { environment.view = next; return conversation.refetch(); },
      dispose() { closeConversation(); dispose(); },
    };
  }
`;

beforeAll(async () => {
  client = await buildContainment(SOURCE, {
    '@/api': `
      export const environment = { view: undefined };
      export const api = {
        onEvent: () => () => undefined,
        core: { conversation: async () => structuredClone(environment.view) },
      };
    `,
    '@/state/plugins': `export const pluginPresents = () => true;`,
    '@/state/chatSettings': `
      import { DEFAULT_DISCORD_CHAT_SETTINGS } from '@shared/chatSettings';
      export const discordChatSettings = () => DEFAULT_DISCORD_CHAT_SETTINGS;
    `,
    '@/state/savedFiles': `export const canSave = () => false, saveAttachment = () => {}, savesThroughMain = false;`,
    '@/state/ui': `export const setLightbox = () => {};`,
    '@/ui/AnimatedImage': `export const AnimatedImage = () => null;`,
    '@/ui/icons': `export const Icon = () => null;`,
    '@/theme/look': `export const look = {};`,
    './AttachmentTile': `export const AttachmentTile = (props) => props.children;`,
    './TextAttachment': `export const TextAttachment = () => null;`,
    './MessageExtras': `export const mediaSizeVars = () => ({});`,
  });
});

const ROOT = 'root-message';
const CHANNEL = 'root-channel';
const SHA256_HEX_LENGTH = 64;
const base = postedArchiveMessage(acceptedMessage({ channelId: CHANNEL, text: '', nonce: '0', files: [], replyTo: null, stickerId: null, gif: null }).message, '0');
const attachment = (id: string, kind: 'video' | 'audio'): ArchiveAttachment => ({
  id, filename: `${id}.${kind === 'video' ? 'mp4' : 'mp3'}`, contentType: kind === 'video' ? 'video/mp4' : 'audio/mpeg',
  size: 1, width: null, height: null, sha256: 'a'.repeat(SHA256_HEX_LENGTH),
  storedExt: kind === 'video' ? 'mp4' : 'mp3', storedBytes: 1, compressed: false,
  status: 'stored', notes: [], description: null, spoiler: false, animated: false, removed: false,
});
const snapshot = (attachments: ArchiveAttachment[]): ConversationView => ({
  messages: [{ ...base, id: ROOT, attachments, reactions: [{ emoji: { id: null, name: '👍', animated: false }, count: 1, me: false }] }],
  linkedIds: [ROOT], pending: false, rootId: ROOT, marks: {}, memberCount: 1, unlinkedMore: false,
  members: { [ROOT]: { kind: 'reply', confidence: 1, explicit: true, questionable: false, branch: 0 } },
});
const nodes = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(nodes)];
const media = (root: TestNode): TestNode[] => nodes(root).filter((node) => node.tag === 'video' || node.tag === 'audio');

describe('conversation media across full snapshots', () => {
  it.each([
    ['video', [attachment('video', 'video')]],
    ['audio', [attachment('audio', 'audio')]],
    ['video mosaic', [attachment('first', 'video'), attachment('second', 'video')]],
  ] as const)('preserves the rendered %s nodes when only a reaction changes', async (_kind, attachments) => {
    const original = snapshot([...attachments]);
    const mounted = client.mount(original);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = media(mounted.root);
      expect(before).toHaveLength(attachments.length);
      const beforeAttachment = mounted.snapshot().messages[0]!.attachments[0];
      const beforeReaction = mounted.snapshot().messages[0]!.reactions[0];
      const changed = structuredClone(original);
      changed.messages[0]!.reactions[0]!.count++;
      changed.messages[0]!.reactions[0]!.me = true;
      await mounted.refresh(changed);
      const after = media(mounted.root);
      expect(after).toHaveLength(before.length);
      before.forEach((element, index) => expect(after[index]).toBe(element));
      expect(mounted.snapshot().messages[0]!.attachments[0]).toBe(beforeAttachment);
      expect(mounted.snapshot().messages[0]!.reactions[0]).toBe(beforeReaction);
      expect(beforeReaction?.count).toBe(2);
      expect(beforeReaction?.me).toBe(true);
    } finally {
      mounted.dispose();
    }
  });
});
