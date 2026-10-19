import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import type { PersonProfile } from '@shared/types/people';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const env = vi.hoisted(() => ({
  emit: (_event: AppEvent): void => undefined,
  read: vi.fn<() => Promise<PersonProfile | null>>(),
}));
vi.mock('@/api', () => ({ api: {
  core: { personProfile: env.read, discordProfile: async () => null },
  discord: { profile: async () => null },
  onEvent: (fn: (event: AppEvent) => void) => { env.emit = fn; return () => undefined; },
} }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined }));
vi.mock('../src/renderer/src/state/archive', () => ({ shownChannelId: () => null }));

// Variable paths keep renderer imports out of the node type-check.
const statePath = '../src/renderer/src/state/person';
const state = await import(statePath) as {
  person: { (): PersonProfile | null | undefined; readonly loading: boolean; refetch(): Promise<void> };
  openPerson(userId: string, channelId: string | null): void;
  closePerson(): void;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
const profile = (): PersonProfile => ({
  id: 'person', username: 'name', globalName: null, avatar: null,
  style: { font: null, decoration: null, tag: null }, nicknames: [],
  totals: { messages: 0, edited: 0, deleted: 0, links: 0, attachments: 0 }, firstTs: null, lastTs: null,
  channels: [], links: [],
});

afterEach(() => { state.closePerson(); env.read.mockReset(); });

describe('person privacy changes', () => {
  it.each([false, true])('hides pre-privacy responses, with an existing profile: %s', async (cached) => {
    const privateProfile = { ...profile(), nicknames: [{ guildId: 'hidden', guildName: 'Hidden server', nick: 'private nickname', channelId: 'hidden-channel' }] };
    if (cached) {
      env.read.mockResolvedValueOnce(privateProfile);
      state.openPerson('person', null);
      await settle();
      expect(state.person()?.nicknames[0]?.nick).toBe('private nickname');
    }
    let answerOld!: (value: PersonProfile) => void;
    let answerVisible!: (value: PersonProfile) => void;
    env.read
      .mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { answerVisible = resolve; }));
    if (cached) void state.person.refetch();
    else state.openPerson('person', null);
    env.emit({ type: 'privacy-changed' });
    expect(state.person()).toBeUndefined();
    answerOld(privateProfile);
    await settle();
    expect(state.person()).toBeUndefined();
    expect(state.person.loading).toBe(true);
    answerVisible(profile());
    await settle();
    expect(state.person()?.nicknames).toEqual([]);
  });
});
