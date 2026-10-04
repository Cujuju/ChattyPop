// Channel policy controls and permitted Jev menu actions.
import { api } from '@/api';
import { coverageText } from '@/plugins/presentation';
import type { DirectoryChannel } from '@shared/contract';
import type { TextTier } from '@shared/settings';
import { channelById, isThread } from './directory';
import { aiSettings } from './preferences';
import { localProviderNames } from './aiProviders';
import { orList } from '@shared/lists';
import { channelPrivacyItem } from './privacy';
import { channelJevContributions } from '@/plugins/slots';
import { setJevAskChannel, type MenuGroup, type MenuItem } from './ui';
import type { IconName } from '@/ui/iconNames';

/** Who reads a local-AI-only channel: the local providers that can run, by name. */
const localOnlyDetail = (): string => `${orList(localProviderNames()) || 'Local models'} only; hosted AI and Jev skip it`;

const TIER_ICONS: Record<TextTier, IconName> = { full: 'archive', compressed: 'compress', 'summary-only': 'summary' };
const TIER_LABELS = (): Record<TextTier, string> => ({ full: 'Keep as captured', compressed: 'Compress', 'summary-only': coverageText().short });

/** Local AI only: the channel's messages go only to a local provider. */
export const localAiItem = (c: DirectoryChannel): MenuItem => ({
  label: 'Local AI only',
  icon: 'cpu',
  detail: localOnlyDetail(),
  checked: c.localAiOnly,
  run: () => api.core.setChannelPolicy(c.id, { localAiOnly: !c.localAiOnly }),
});

/** Right-click menu on a channel: private, local-AI-only and its own text tier. Threads follow their channel, so they get none. */
export function channelPolicyMenu(c: DirectoryChannel): MenuGroup[] {
  if (isThread(c)) return [];
  const set = (policy: Parameters<typeof api.core.setChannelPolicy>[1]): Promise<void> => api.core.setChannelPolicy(c.id, policy);
  return [
    {
      items: [
        channelPrivacyItem(c),
        localAiItem(c),
      ],
    },
    {
      heading: 'Older messages',
      exclusive: true,
      items: [
        { label: 'As in Settings', icon: 'settings', checked: c.textTier === null, run: () => set({ textTier: null }) },
        ...(Object.keys(TIER_LABELS()) as TextTier[]).map((t) => ({ label: TIER_LABELS()[t], icon: TIER_ICONS[t], checked: c.textTier === t, run: () => set({ textTier: t }) })),
      ],
    },
  ];
}

/** Whether Jev (a hosted model) may read the channel: archived, and not local AI only (a thread by its parent's policy). */
export function jevMayRead(channelId: string): boolean {
  const c = channelById(channelId);
  return c !== undefined && c.optedIn && !c.localAiOnly;
}

/**
 * Jev actions on a whole channel, for every menu that offers them (channel row, message): ask about it, tag its
 * messages. Empty when Jev may not read it.
 */
export function channelJevItems(channelId: string): MenuItem[] {
  const c = channelById(channelId);
  if (!c || !jevMayRead(channelId)) return [];
  const items: MenuItem[] = [];
  if (aiSettings().jev.messageCheck) items.push({ label: 'Ask about this channel…', icon: 'jev', run: () => void setJevAskChannel(c.id) });
  items.push(...channelJevContributions(c));
  return items;
}

/** The channel row's right-click menu: its policy, then Jev's channel actions. */
export const channelMenu = (c: DirectoryChannel): MenuGroup[] => [...channelPolicyMenu(c), { heading: 'Jev', items: channelJevItems(c.id) }];
