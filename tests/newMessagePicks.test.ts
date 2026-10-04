// Contract (docs/dms.md §4.3): New message never sends the same people twice. Picks still sending, or that Discord gave
// no clear answer for, stay held after the window closes and reopens; a write finishing after its window closed opens
// nothing. Enter picks the highlighted person; it sends only with none highlighted, or with Ctrl.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmOutcome } from '@shared/dms';

// The client runtime, so signals behave as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  answers: [] as ((o: DmOutcome) => void)[],
  shown: [] as string[],
}));
// Stored settings: in memory here.
vi.mock('@plugin-sdk/renderer/settings', () => {
  const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  return { createSetting: <T>(_key: string, initial: T) => createSignal(initial) };
});
vi.mock('@/api', () => ({
  api: {
    discord: {
      friends: async () => [],
      startDm: () => new Promise<DmOutcome>((resolve) => env.answers.push(resolve)),
    },
  },
}));
vi.mock('../src/renderer/src/state/archive', () => ({
  openArchive: async (id: string) => void env.shown.push(id),
  openChannel: (c: { id: string }) => void env.shown.push(c.id),
  openLive: (c: { id: string }) => void env.shown.push(c.id),
}));
vi.mock('../src/renderer/src/state/composer', () => ({ focusComposer: () => undefined }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined, refetchDirectory: async () => undefined }));
vi.mock('../src/renderer/src/state/dms', () => ({ dmPerson: () => null, openDmWith: () => undefined, openOneToOnes: () => [] }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('virtual:bundled-plugins/shared', async () => (await import('./postingSwitch')).bundledPluginsModule);
vi.mock('../src/renderer/src/state/plugins', async () => (await import('./postingSwitch')).pluginsModule);

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/newMessage';
const nm = (await import(statePath)) as {
  openNewMessage(): void;
  closeNewMessage(): void;
  sendPicks(addTo: undefined, people: string[], archive: boolean): Promise<DmOutcome>;
  pickKey(addTo: string | null, people: readonly string[]): string;
  pickSending(key: string): boolean;
  pickUnconfirmed(key: string): boolean;
  enterSends(e: { ctrlKey: boolean; metaKey: boolean }, highlighted: boolean): boolean;
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
let people: string[];
let n = 0;
beforeEach(() => {
  // Fresh people per test: held picks outlive a test, as they outlive a window.
  people = [`11000000000000000${++n}`, `12000000000000000${n}`];
  env.answers.length = 0;
  env.shown.length = 0;
});
const reopen = (): void => {
  nm.closeNewMessage();
  nm.openNewMessage();
};

describe('Enter in the To field', () => {
  it("picks the highlighted person, as Forward's does; sends with no one highlighted, or with Ctrl or Cmd", () => {
    const plain = { ctrlKey: false, metaKey: false };
    expect(nm.enterSends(plain, true)).toBe(false);
    expect(nm.enterSends(plain, false)).toBe(true);
    expect(nm.enterSends({ ...plain, ctrlKey: true }, true)).toBe(true);
    expect(nm.enterSends({ ...plain, metaKey: true }, true)).toBe(true);
  });
});

describe('New message picks', () => {
  it('still sending after the window closed and reopened: held, and the answer opens nothing', async () => {
    nm.openNewMessage();
    const sent = nm.sendPicks(undefined, people, true);
    reopen();
    expect(nm.pickSending(nm.pickKey(null, [...people].reverse()))).toBe(true);
    await expect(nm.sendPicks(undefined, people, true)).rejects.toThrow('just sent');
    env.answers[0]!({ kind: 'created', channelId: '400000000000000001' });
    await sent;
    await settle();
    expect(env.answers).toHaveLength(1);
    expect(env.shown).toEqual([]);
    expect(nm.pickSending(nm.pickKey(null, people))).toBe(false);
  });

  it('with no clear answer: held after reopening, and never sent again', async () => {
    nm.openNewMessage();
    const sent = nm.sendPicks(undefined, people, true);
    env.answers[0]!({ kind: 'uncertain' });
    await sent;
    reopen();
    expect(nm.pickUnconfirmed(nm.pickKey(null, people))).toBe(true);
    await expect(nm.sendPicks(undefined, people, true)).rejects.toThrow('just sent');
    expect(env.answers).toHaveLength(1);
  });

  it('answered while its window stays open: what it made is shown', async () => {
    nm.openNewMessage();
    const sent = nm.sendPicks(undefined, people, true);
    env.answers[0]!({ kind: 'created', channelId: '400000000000000002' });
    await sent;
    expect(env.shown).toEqual(['400000000000000002']);
  });
});
