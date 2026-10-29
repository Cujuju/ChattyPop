// The `/` menu's app commands are the open channel's only: never another channel's list or failure while its own loads.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AppCommand, CommandIndex } from '@shared/commands';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);

/** Command list reads by channel, each answered by the test. */
const reads = new Map<string, { answer(i: CommandIndex): void; fail(e: Error): void }[]>();
vi.mock('@/api', () => ({
  api: {
    discord: { commands: (channelId: string) => new Promise((answer, fail) => reads.set(channelId, [...(reads.get(channelId) ?? []), { answer, fail }])) },
    core: { ownCommands: async () => [] },
  },
}));
/** Two servers with a channel each: a channel search answers from the server it names. */
const SERVERS = [{ id: '100000000000000001', channels: [{ id: 'c1', name: 'general', kind: 0 }] }, { id: '100000000000000002', channels: [{ id: 'c2', name: 'general-two', kind: 0 }] }];
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined, directory: () => SERVERS }));
vi.mock('../src/renderer/src/state/localCommands', () => ({ LOCAL_COMMANDS: [] }));
vi.mock('../src/renderer/src/state/posting', () => ({ closeWhenLocked: () => undefined, postingUnlocked: () => true }));
vi.mock('../src/renderer/src/plugins/slots', () => ({ composerCommands: () => [] }));

interface CommandsModule {
  openCommandMenu(channelId: string, guildId: string): void;
  commandsLoading(): boolean;
  commandsError(): string | null;
  menuSections(channelId: string, typed: string): { id: string; mark: { kind: string } }[];
  createEntitySearch(search: () => { kind: 'channel' | 'role' | 'user' | 'mentionable'; guildId: string; query: string; channelTypes: number[] } | false): () => { id: string }[] | undefined;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const commandsPath = '../src/renderer/src/state/commands';
const menu = (await import(commandsPath)) as CommandsModule;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
const GUILD = '100000000000000001';
const [A, B] = ['200000000000000001', '200000000000000002'];
const command = (applicationId: string): AppCommand => ({ id: `${applicationId}-cmd`, applicationId, version: '1', name: 'roll', description: '', options: [] });
const index = (applicationId: string): CommandIndex => ({ apps: [{ id: applicationId, name: applicationId } as CommandIndex['apps'][number]], commands: [command(applicationId)] });
const pending = (channelId: string) => reads.get(channelId)!.shift()!;
const apps = (channelId: string): string[] => menu.menuSections(channelId, '').filter((s) => s.mark.kind === 'app').map((s) => s.id);

describe("the / menu's app commands", () => {
  it("are the open channel's, kept while it reloads, and never another channel's or its failure", async () => {
    menu.openCommandMenu(A, GUILD);
    pending(A).answer(index('app-a'));
    await settle();
    expect(apps(A)).toEqual(['app-a']);
    // Reopening asks again and keeps the list shown until the new one lands.
    menu.openCommandMenu(A, GUILD);
    expect(apps(A)).toEqual(['app-a']);
    pending(A).fail(new Error('Discord is down'));
    await settle();
    expect(menu.commandsError()).toBe('Discord is down');
    menu.openCommandMenu(B, GUILD);
    expect(apps(B)).toEqual([]);
    expect(menu.commandsLoading()).toBe(true);
    expect(menu.commandsError()).toBeNull();
    pending(B).answer(index('app-b'));
    await settle();
    expect(apps(B)).toEqual(['app-b']);
    expect(apps(A)).toEqual([]);
  });
});

describe("a picker's entity search", () => {
  it('searches again when any part of the request changes, not only its text', async () => {
    const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
    const [guildId, setGuildId] = createSignal(SERVERS[0]!.id);
    const found = createRoot(() => menu.createEntitySearch(() => ({ kind: 'channel', guildId: guildId(), query: 'general', channelTypes: [] })));
    await settle();
    expect(found()?.map((c) => c.id)).toEqual(['c1']);
    setGuildId(SERVERS[1]!.id);
    expect(found()).toBeUndefined();
    await settle();
    expect(found()?.map((c) => c.id)).toEqual(['c2']);
  });
});
