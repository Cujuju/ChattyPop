// Conversation view: which message's exchange the Conversation window shows, and that exchange from core.
import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { onAppEvent } from './events';

export const [conversationFor, setConversationFor] = createSignal<string | null>(null);

export const [conversation, { refetch: refetchConversation }] = createResource(conversationFor, (id) => api.core.conversation(id));

export const openConversation = (messageId: string): void => {
  if (conversationFor() === messageId) void refetchConversation();
  else setConversationFor(messageId);
};

export const closeConversation = (): void => {
  setConversationFor(null);
};

onAppEvent('privacy-changed', () => {
  if (conversationFor()) void refetchConversation();
});
