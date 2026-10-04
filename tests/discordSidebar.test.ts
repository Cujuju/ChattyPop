import { describe, expect, it } from 'vitest';
import { HOVER_EDGE_PX, sidebarCss } from '../src/main/discord/sidebarCss';
import { DEFAULT_DISCORD_SIDEBAR, normalizeDiscordSidebar } from '../src/shared/settings';

describe('discord sidebar settings', () => {
  it('normalizes anything to two booleans, defaulting to shown', () => {
    expect(normalizeDiscordSidebar(undefined)).toEqual(DEFAULT_DISCORD_SIDEBAR);
    expect(normalizeDiscordSidebar({ serversHidden: 'yes', channelsCollapsed: 1 })).toEqual(DEFAULT_DISCORD_SIDEBAR);
    expect(normalizeDiscordSidebar({ serversHidden: true, channelsCollapsed: true, extra: 1 })).toEqual({ serversHidden: true, channelsCollapsed: true });
  });
});

describe('discord sidebar css', () => {
  it('injects nothing when both columns are shown', () => {
    expect(sidebarCss(DEFAULT_DISCORD_SIDEBAR)).toBe('');
  });

  it('hides the server column and gives back its width', () => {
    const css = sidebarCss({ serversHidden: true, channelsCollapsed: false });
    expect(css).toContain('nav[class*="guilds_"] { display: none !important; }');
    expect(css).toContain('calc(var(--custom-guild-sidebar-width) - var(--custom-guild-list-width))');
    expect(css).not.toContain(':hover');
  });

  it('collapses channels only while unhovered, keeping the server column unless it is hidden too', () => {
    const withServers = sidebarCss({ serversHidden: false, channelsCollapsed: true });
    expect(withServers).toContain(`width: calc(var(--custom-guild-list-width) + ${HOVER_EDGE_PX}px) !important`);
    expect(withServers.match(/width: [^;]*!important/g)?.length).toBe(2);
    for (const rule of withServers.split('\n').filter((r) => /!important|visibility: hidden/.test(r))) expect(rule).toContain(':not(:hover)');

    const alone = sidebarCss({ serversHidden: true, channelsCollapsed: true });
    expect(alone).toContain(`width: calc(0px + ${HOVER_EDGE_PX}px) !important`);
  });

  it('scopes every rule to the app shell sidebar', () => {
    const css = sidebarCss({ serversHidden: true, channelsCollapsed: true });
    for (const rule of css.split('\n')) {
      for (const selector of rule.slice(0, rule.indexOf('{')).split(',')) expect(selector.trim()).toMatch(/^\[class\^="base_"\] > \[class\^="content_"\] > \[class\^="sidebar_"\]/);
    }
  });
});
