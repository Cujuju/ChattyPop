// A profile opens in the server of the place it was opened from (a Bookmarks or Conversation message's channel), not the
// Archive's. The host's openPerson requires that place (the type check holds every caller to it); the SDK's keeps its
// old default, the Archive's shown channel, for plugins that omit it.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({ asked: [] as (string | null)[] }));
/** The Archive shows a channel in server A; the clicked message is in server B. */
const CHANNELS: Record<string, { guildId: string }> = { archiveShown: { guildId: 'guild-A' }, bookmarked: { guildId: 'guild-B' } };
vi.mock('@/api', () => ({
  api: {
    core: { personProfile: async () => null, discordProfile: async () => null },
    discord: {
      profile: async (_userId: string, guildId: string | null) => {
        env.asked.push(guildId);
        return {};
      },
    },
  },
}));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: (id: string) => CHANNELS[id] }));
vi.mock('../src/renderer/src/state/shownChannel', () => ({ shownChannelId: () => 'archiveShown' }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const personPath = '../src/renderer/src/state/person';
const person = (await import(personPath)) as {
  openPerson(userId: string, channelId: string | null): void;
  openPersonFromPlugin(userId: string, channelId?: string | null): void;
  personGuildId(): string | null;
  closePerson(): void;
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

describe("a profile's server", () => {
  it("is the clicked message's, while the Archive shows another server", async () => {
    env.asked.length = 0;
    person.openPerson('u1', 'bookmarked');
    expect(person.personGuildId()).toBe('guild-B');
    await settle();
    expect(env.asked).toEqual(['guild-B']);
    person.closePerson();
  });

  it("a plugin's call without a place opens in the Archive's server, as before", () => {
    person.openPersonFromPlugin('u2');
    expect(person.personGuildId()).toBe('guild-A');
    person.openPersonFromPlugin('u3', 'bookmarked');
    expect(person.personGuildId()).toBe('guild-B');
    person.closePerson();
  });
});
