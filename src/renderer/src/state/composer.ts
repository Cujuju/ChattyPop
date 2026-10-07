// The Archive composer: sends a channel's draft (drafts.ts) as the owner, through the outbox.
import { createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { applyBuiltinCommand, expandEmojiTokens, expandMentionTokens, type Gif, type OwnerMessage } from '@shared/compose';
import { newNonce } from '@shared/discord';
import { convertEmoticons } from '@shared/emoticons';
import { discordChatSettings } from './chatSettings';
import { takeDraft } from './drafts';
import { enqueue } from './outbox';
import { cancelReply, replyPing, replyTarget } from './reply';

/** Bumped to move the typing into the shown composer (a conversation just opened there). */
const [composerFocus, setComposerFocus] = createSignal(0);
export { composerFocus };
export const focusComposer = (): void => void setComposerFocus((n) => n + 1);

export { attachFiles, customEmojiToken, draftError, draftFiles, draftText, mentionCandidateToken, removeFile, setDraftText, type DraftFile } from './drafts';

/** The reply the composer carries: the target, while it is in this channel. */
const replyIn = (channelId: string): OwnerMessage['replyTo'] => {
  const t = replyTarget();
  return t && t.channelId === channelId ? { messageId: t.id, ping: replyPing() } : null;
};

/** Clears drafts/replies immediately while queuing text/stickers with built-in rewrites. Editing unsent entries restores them into empty drafts. */
export function sendDraft(channelId: string, stickerId: string | null = null): void {
  const replyTo = replyIn(channelId);
  // Unwrapped: the saved draft is kept in IndexedDB, which can't clone a store proxy.
  const target = replyTo ? unwrap(replyTarget()) : null;
  const draft = takeDraft(channelId, target);
  if (target) cancelReply();
  const { files } = draft;
  // Discord's "Automatically convert emoticons": applied to what is sent, not to the draft kept for editing.
  const text = discordChatSettings().convertEmoticons ? convertEmoticons(draft.text) : draft.text;
  enqueue({
    channelId,
    label: text.trim() || (stickerId ? 'Sticker' : `${files.length} ${files.length === 1 ? 'file' : 'files'}`),
    message: Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))).then((bytes) => ({
      channelId,
      text: expandMentionTokens(expandEmojiTokens(applyBuiltinCommand(text), new Map(draft.emoji)), new Map(draft.mentions)),
      replyTo,
      files: bytes,
      stickerId,
      gif: null,
      nonce: newNonce(),
    })),
    bytes: files.reduce((n, f) => n + f.size, 0),
    // A sticker isn't part of the draft, so a message with one can't go back.
    draft: stickerId === null ? draft : null,
  });
}

/** Queues a GIF on its own, as the live client sends it (its page URL as the text); the typed draft stays. */
export function sendGif(channelId: string, gif: Gif, query: string): void {
  const replyTo = replyIn(channelId);
  if (replyTo) cancelReply();
  enqueue({
    channelId,
    label: 'GIF',
    message: Promise.resolve({ channelId, text: gif.url, replyTo, files: [], stickerId: null, gif: { id: gif.id, query }, nonce: newNonce() }),
    bytes: 0,
    draft: null,
  });
}
