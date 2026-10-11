// A remote desktop's view of the sign-in relay (renderer state/discordLogin.ts): read when the page loads, so a page
// that loads while a relay runs shows it, then pushed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import type { LoginFrame, LoginRelayState } from '@shared/discordLogin';

/** The server's answer to the page's load-time read; a test may hold it back. */
const server = { relay: Promise.resolve<LoginRelayState>({ running: false, frame: null }) };
const listeners = new Map<string, (e: AppEvent) => void>();

vi.mock('@/api', () => ({ api: { discord: { loginRelayState: () => server.relay } } }));
vi.mock('../src/renderer/src/state/events', () => ({
  onAppEvent: (type: string, listener: (e: AppEvent) => void) => void listeners.set(type, listener),
  createPushedValue: () => ({ value: () => 'signed-out' }),
}));

const FRAME: LoginFrame = { data: 'abc', width: 1200, height: 800 };
const push = (e: AppEvent): void => listeners.get(e.type)!(e);
/** The state module's surface these tests use; imported by path, as the node type check doesn't hold renderer code. */
interface RelayView {
  relayRunning(): boolean;
  loginFrame(): LoginFrame | null;
}
const STATE = '../src/renderer/src/state/discordLogin.ts';
const load = async (): Promise<RelayView> => (await import(STATE)) as RelayView;
/** Lets the load-time read's answer land. */
const settled = (): Promise<void> => new Promise((done) => setImmediate(done));

describe("a remote desktop's view of the sign-in relay", () => {
  beforeEach(() => {
    listeners.clear();
    vi.resetModules();
  });

  it('shows a relay that was already running when the page loaded, with its latest frame', async () => {
    server.relay = Promise.resolve({ running: true, frame: FRAME });
    const state = await load();
    await settled();
    expect(state.relayRunning()).toBe(true);
    expect(state.loginFrame()).toEqual(FRAME);
  });

  it('shows none when none runs', async () => {
    server.relay = Promise.resolve({ running: false, frame: null });
    const state = await load();
    await settled();
    expect(state.relayRunning()).toBe(false);
    expect(state.loginFrame()).toBeNull();
  });

  it('keeps what the server pushed over an older answer to its load-time read', async () => {
    let answer!: (relay: LoginRelayState) => void;
    server.relay = new Promise((resolve) => (answer = resolve));
    const state = await load();
    push({ type: 'discord-login-relay', running: false });
    answer({ running: true, frame: FRAME });
    await settled();
    expect(state.relayRunning()).toBe(false);
    expect(state.loginFrame()).toBeNull();
  });

  it('takes a frame as a running relay, on a server too old to be asked', async () => {
    server.relay = Promise.reject(new Error('Not a call a remote desktop may make.'));
    const state = await load();
    await settled();
    expect(state.relayRunning()).toBe(false);
    push({ type: 'discord-login-frame', ...FRAME });
    expect(state.relayRunning()).toBe(true);
    expect(state.loginFrame()).toEqual(FRAME);
  });
});
