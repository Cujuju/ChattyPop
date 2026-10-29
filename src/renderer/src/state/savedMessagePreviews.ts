// Saved previews read only the existing, privacy-filtered local Archive API.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createMemo, type Accessor } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { SavedTarget } from '@shared/savedMessages';
import { api } from '@/api';
import { onAppEvent, onArchiveChange, onMessagePartsChanged } from './events';
import { keyedResource } from './keyedResource';
import { savedMessages } from './savedMessages';

/** A card's archive snapshot, fenced by its target/account/read state and disposed with the card. */
export function createSavedMessagePreview(target: Accessor<SavedTarget>): Accessor<ArchiveMessage | null> {
  const source = createMemo(() => {
    const state = savedMessages(), row = target();
    return state.session && !state.stale
      ? JSON.stringify([state.session, state.revision, state.pageEpoch, row.channelId, row.messageId])
      : false;
  });
  const result = keyedResource(source, async () => {
    const { channelId, messageId } = target();
    const message = await api.core.messageById(messageId).catch(() => null);
    return message?.id === messageId && message.channelId === channelId ? message : null;
  });
  const invalidate = (): void => void result.invalidate();
  const offs = [
    onAppEvent('privacy-changed', invalidate),
    onArchiveChange({ kinds: ['messages', 'edits', 'deletes', 'reactions', 'polls', 'attachments', 'links', 'names', 'plugin'], scope: () => ({ channelIds: [target().channelId] }) }, invalidate),
    onMessagePartsChanged((ids) => { if (ids === null || ids.includes(target().messageId)) invalidate(); }),
  ];
  onCleanup(() => offs.forEach((off) => off()));
  return () => result() ?? null;
}
