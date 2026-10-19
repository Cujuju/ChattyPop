// Saved previews read only the existing, privacy-filtered local Archive API.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { createMemo, createResource, createSignal, type Accessor } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { SavedTarget } from '@shared/savedMessages';
import { api } from '@/api';
import { onAppEvent, onArchiveChange, onMessagePartsChanged } from './events';
import { savedMessages } from './savedMessages';

/** A card's archive snapshot, fenced by its target/account/read state and disposed with the card. */
export function createSavedMessagePreview(target: Accessor<SavedTarget>): Accessor<ArchiveMessage | null> {
  const [refresh, setRefresh] = createSignal(0);
  const invalidate = () => setRefresh((version) => version + 1);
  const source = createMemo(() => {
    const state = savedMessages(), row = target();
    return state.session && !state.stale
      ? JSON.stringify([state.session, state.revision, state.pageEpoch, row.channelId, row.messageId, refresh()])
      : false;
  });
  const [result] = createResource(source, async (key) => {
    const { channelId, messageId } = target();
    const message = await api.core.messageById(messageId).catch(() => null);
    return { key, message: message?.id === messageId && message.channelId === channelId ? message : null };
  });
  const offs = [
    onAppEvent('privacy-changed', invalidate),
    onArchiveChange({ kinds: ['messages', 'edits', 'deletes', 'reactions', 'polls', 'attachments', 'links', 'names', 'plugin'], scope: () => ({ channelIds: [target().channelId] }) }, invalidate),
    onMessagePartsChanged((ids) => { if (ids === null || ids.includes(target().messageId)) invalidate(); }),
  ];
  onCleanup(() => offs.forEach((off) => off()));
  // Resource values can retain the previous read while loading; never show one across a changed scope.
  return () => { const key = source(), loaded = result(); return key && loaded?.key === key ? loaded.message : null; };
}
