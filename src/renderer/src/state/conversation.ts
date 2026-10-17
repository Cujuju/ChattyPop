// Conversation view: which message's exchange the Conversation window shows, and that exchange from core.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import { onAppEvent } from './events';
import { keyedResource } from './keyedResource';

export const [conversationFor, setConversationFor] = createSignal<string | null>(null);

export const conversation = keyedResource(conversationFor, (id) => api.core.conversation(id));

export const openConversation = (messageId: string): void => {
  if (conversationFor() === messageId) conversation.refetch();
  else setConversationFor(messageId);
};

export const closeConversation = (): void => {
  setConversationFor(null);
};

onAppEvent('privacy-changed', () => {
  if (conversationFor()) conversation.refetch();
});
