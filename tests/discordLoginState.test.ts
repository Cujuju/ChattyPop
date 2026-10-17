// A remote desktop's view of the sign-in relay (renderer state/discordLogin.ts): read when the page loads, so a page
// that loads while a relay runs shows it, then pushed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import type { LoginFrame, LoginRelayState, RelayInput } from '@shared/discordLogin';

/** The server's answer to the page's load-time read; a test may hold it back. */
const server = { relay: Promise.resolve<LoginRelayState>({ running: false, frame: null }) };
const listeners = new Map<string, (e: AppEvent) => void>();
/** Input relayed to the server, in order. */
const sent: RelayInput[] = [];

vi.mock('@/api', () => ({ api: { discord: { loginRelayState: () => server.relay, loginInput: async (e: RelayInput) => void sent.push(e) } } }));
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
  createKeyRelay(): (type: 'keyDown' | 'keyUp', e: Key) => void;
}
/** The key event fields the relay reads. */
interface Key {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}
const key = (k: string, code: string, keyCode: number, mods: Partial<Pick<Key, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}): Key => ({
  key: k,
  code,
  keyCode,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  ...mods,
});
/** Windows virtual-key codes the tests press. */
const VK = { CONTROL: 17, V: 86, A: 65 };
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

describe('keys on the relayed frame', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('leaves Ctrl/Cmd+V to the browser, whose paste event sends the text, and relays neither its press nor release', async () => {
    const relay = (await load()).createKeyRelay();
    for (const mod of ['ctrlKey', 'metaKey'] as const) {
      const press = key('v', 'KeyV', VK.V, { [mod]: true });
      relay('keyDown', press);
      relay('keyUp', key('v', 'KeyV', VK.V));
      expect(press.defaultPrevented).toBe(false);
    }
    await settled();
    expect(sent).toEqual([]);
  });

  it('relays and holds other keys, typing printable ones', async () => {
    const relay = (await load()).createKeyRelay();
    const ctrl = key('Control', 'ControlLeft', VK.CONTROL, { ctrlKey: true });
    const selectAll = key('a', 'KeyA', VK.A, { ctrlKey: true });
    const typed = key('v', 'KeyV', VK.V);
    for (const e of [ctrl, selectAll, typed]) relay('keyDown', e);
    await settled();
    expect([ctrl, selectAll, typed].every((e) => e.defaultPrevented)).toBe(true);
    expect(sent.map((e) => (e.kind === 'key' ? [e.key, e.text] : e.kind))).toEqual([['Control', null], ['a', null], ['v', 'v']]);
  });
});
