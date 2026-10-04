import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { ChannelSuggestion } from '@shared/contract';
import { countText, errorText } from '@/ui/format';

/** Suggestions by channel id, from the last run per server; kept for this session only. */
export const [suggestions, setSuggestions] = createSignal<Record<string, ChannelSuggestion>>({});
/** Server being sampled, and the last run's error or note per server. */
export const [suggesting, setSuggesting] = createSignal<string | null>(null);
export const [suggestNote, setSuggestNote] = createSignal<Record<string, string>>({});

/** Samples a server's unarchived channels and asks Jev which match the owner's rules. */
export async function suggestChannels(guildId: string): Promise<void> {
  setSuggesting(guildId);
  try {
    const found = await api.discord.suggestChannels(guildId);
    setSuggestions({ ...suggestions(), ...Object.fromEntries(found.map((s) => [s.channelId, s])) });
    setSuggestNote({
      ...suggestNote(),
      [guildId]: found.length ? `${countText(found.length, 'channel')} match your rules` : 'No channel clearly matches your rules',
    });
  } catch (err) {
    setSuggestNote({ ...suggestNote(), [guildId]: errorText(err) });
  } finally {
    setSuggesting(null);
  }
}
