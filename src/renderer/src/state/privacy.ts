import { api } from '@/api';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { SETTINGS_KEYS } from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import type { MenuGroup, MenuItem } from './ui';

/** Privacy mode: servers and channels marked private leave every view (core filters them) while it is on. */
export const [privacyMode, setPrivacyMode] = createSetting<boolean>(SETTINGS_KEYS.privacyMode, false, (v) => v === true);
export const togglePrivacyMode = (): void => void setPrivacyMode(!privacyMode());

/** Right-click item marking a channel private; its threads follow it. */
export const channelPrivacyItem = (c: DirectoryChannel): MenuItem => ({
  label: 'Private',
  icon: 'eyeOff',
  detail: 'Hidden in privacy mode',
  checked: c.hideInPrivacy,
  run: () => api.core.setChannelPolicy(c.id, { hideInPrivacy: !c.hideInPrivacy }),
});

/** Right-click menu on a server: mark it private with all its channels. The DM group has none; mark DMs one by one. */
export const guildPrivacyMenu = (g: DirectoryGuild): MenuGroup[] =>
  g.id === DM_GUILD_ID
    ? []
    : [
        {
          items: [
            {
              label: 'Private server',
              icon: 'eyeOff',
              detail: 'Hidden in privacy mode, with all its channels',
              checked: g.hideInPrivacy,
              run: () => api.core.setGuildHideInPrivacy(g.id, !g.hideInPrivacy),
            },
          ],
        },
      ];
