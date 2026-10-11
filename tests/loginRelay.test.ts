// Signing the server's Discord client in from another machine (main/discord/loginRelay.ts): the window shows while
// a relay streams, frames go out as events, the owner's input comes back as CDP input, and signing in ends it.
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { normalizeRelayInput, type DiscordSessionState } from '@shared/discordLogin';
import { HeaderCapture } from '../src/main/discord/capture';
import { LoginRelay, followSession } from '../src/main/discord/loginRelay';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

/** A relay whose client is at `state`: signed out unless a test says otherwise, as a relay starts only there. */
function harness({ visible = false, state = 'signed-out' as DiscordSessionState } = {}) {
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<object> => ({}));
  const dbg = Object.assign(debuggerEvents, { sendCommand });
  const win = { visible, isVisible: () => win.visible, showInactive: vi.fn(() => void (win.visible = true)), hide: vi.fn(() => void (win.visible = false)), isDestroyed: () => false };
  const holdForRelay = vi.fn();
  const events: AppEvent[] = [];
  const relay = new LoginRelay({ win, view: { webContents: { debugger: dbg as never }, holdForRelay }, emit: (e) => void events.push(e), diag: () => undefined });
  relay.setState(state);
  events.length = 0;
  const frame = (data: string) => dbg.emit('message', {}, 'Page.screencastFrame', { data, sessionId: 7, metadata: { deviceWidth: 1200, deviceHeight: 800 } });
  return { relay, win, holdForRelay, events, sendCommand, frame };
}

describe('the sign-in relay', () => {
  it("shows the hidden server window with the Discord page over it, and streams that page's frames", async () => {
    const h = harness();
    await h.relay.start();
    expect(h.win.showInactive).toHaveBeenCalledOnce();
    expect(h.holdForRelay).toHaveBeenLastCalledWith(true);
    expect(h.sendCommand).toHaveBeenCalledWith('Page.startScreencast', expect.objectContaining({ format: 'jpeg' }));
    h.frame('abc');
    expect(h.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 7 });
    expect(h.events).toEqual([{ type: 'discord-login-relay', running: true }, { type: 'discord-login-frame', data: 'abc', width: 1200, height: 800 }]);
  });

  it('hides the window again when it stops, and sends no frame after', async () => {
    const h = harness();
    await h.relay.start();
    await h.relay.stop();
    expect(h.holdForRelay).toHaveBeenLastCalledWith(false);
    expect(h.win.hide).toHaveBeenCalledOnce();
    expect(h.sendCommand).toHaveBeenCalledWith('Page.stopScreencast', undefined);
    h.frame('late');
    expect(h.events.at(-1)).toEqual({ type: 'discord-login-relay', running: false });
  });

  it("leaves a window that was already shown as it was", async () => {
    const h = harness({ visible: true });
    await h.relay.start();
    await h.relay.stop();
    expect(h.win.showInactive).not.toHaveBeenCalled();
    expect(h.win.hide).not.toHaveBeenCalled();
  });

  it('tells a page that loads while it runs that it runs, with its latest frame', async () => {
    const h = harness();
    expect(h.relay.relayState).toEqual({ running: false, frame: null });
    await h.relay.start();
    expect(h.relay.relayState).toEqual({ running: true, frame: null });
    h.frame('abc');
    expect(h.relay.relayState).toEqual({ running: true, frame: { data: 'abc', width: 1200, height: 800 } });
    await h.relay.stop();
    expect(h.relay.relayState).toEqual({ running: false, frame: null });
    // The next relay starts without the last one's picture.
    await h.relay.start();
    expect(h.relay.relayState).toEqual({ running: true, frame: null });
    h.relay.setState('signed-in');
    expect(h.relay.relayState).toEqual({ running: false, frame: null });
  });

  it('starts only at the sign-in page: a signed-in client is never shown or driven', async () => {
    for (const state of ['unknown', 'signed-in'] as const) {
      const h = harness({ state });
      await expect(h.relay.start()).rejects.toThrow(/sign-in page/);
      h.frame('live');
      await h.relay.input({ kind: 'text', text: 'typed' });
      expect(h.sendCommand).not.toHaveBeenCalled();
      expect(h.win.showInactive).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    }
  });

  it('sends no frame and takes no input from the moment the client signs in', async () => {
    const h = harness();
    await h.relay.start();
    h.relay.setState('signed-in');
    // The stop it caused has yet to run.
    h.frame('live');
    await h.relay.input({ kind: 'text', text: 'typed' });
    expect(h.events.some((e) => e.type === 'discord-login-frame')).toBe(false);
    expect(h.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('keeps the relay started while an earlier stop was still finishing', async () => {
    const h = harness();
    await h.relay.start();
    let finishStop = (): void => undefined;
    h.sendCommand.mockImplementationOnce(() => new Promise<object>((done) => (finishStop = () => done({}))));
    const stopping = h.relay.stop();
    const starting = h.relay.start();
    await vi.waitFor(() => expect(h.sendCommand).toHaveBeenCalledWith('Page.stopScreencast', undefined));
    finishStop();
    await Promise.all([stopping, starting]);
    expect(h.holdForRelay.mock.calls).toEqual([[true], [false], [true]]);
    expect(h.events.at(-1)).toEqual({ type: 'discord-login-relay', running: true });
    h.frame('abc');
    expect(h.events.at(-1)).toMatchObject({ type: 'discord-login-frame', data: 'abc' });
    // The second relay showed the window again, so its stop hides it.
    await h.relay.stop();
    expect(h.win.hide).toHaveBeenCalledTimes(2);
  });

  it("replays the owner's pointer, keys and pasted text on the page, only while it runs", async () => {
    const h = harness();
    await h.relay.input({ kind: 'text', text: 'early' });
    expect(h.sendCommand).not.toHaveBeenCalled();
    await h.relay.start();
    await h.relay.input({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
    await h.relay.input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', keyCode: 65 });
    await h.relay.input({ kind: 'text', text: 'hunter2' });
    expect(h.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 }));
    expect(h.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    expect(h.sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'hunter2' });
  });

  it('says when the client signs in, and stops streaming then', async () => {
    const h = harness({ state: 'unknown' });
    h.relay.setState('signed-out');
    await h.relay.start();
    h.relay.setState('signed-in');
    await vi.waitFor(() => expect(h.win.hide).toHaveBeenCalled());
    expect(h.relay.state).toBe('signed-in');
    expect(h.events.filter((e) => e.type === 'discord-session')).toEqual([
      { type: 'discord-session', state: 'signed-out' },
      { type: 'discord-session', state: 'signed-in' },
    ]);
  });
});

describe("the client's sign-in, as the relay follows it", () => {
  type Send = (details: { method: string; url: string; webContentsId: number; requestHeaders: Record<string, string> }, cb: () => void) => void;

  /** The client's page and its captured requests, as a test drives them. */
  function client() {
    let send: Send | undefined;
    const session = { webRequest: { onBeforeRequest: () => undefined, onBeforeSendHeaders: (_f: unknown, l: Send) => (send = l), onCompleted: () => undefined } };
    const capture = new HeaderCapture(session as never);
    const page = { onLoginPage: undefined as ((atLogin: boolean) => void) | undefined };
    const request = (authorization: string): void => send!({ method: 'GET', url: 'https://discord.com/api/v9/users/@me', webContentsId: 1, requestHeaders: { Authorization: authorization } }, () => undefined);
    return { capture, page, request };
  }

  it('ends a relay at a sign-in that follows a sign-out, though the old token was still captured', async () => {
    const h = harness({ state: 'unknown' });
    const c = client();
    const signedIn = vi.fn();
    followSession(h.relay, c, signedIn);
    c.request('first');
    expect(h.relay.state).toBe('signed-in');
    // Signed out in the client; no request of ChattyPop's met a 401 to void the token.
    c.page.onLoginPage!(true);
    expect(h.relay.state).toBe('signed-out');
    expect(c.capture.current).toBeUndefined();
    await h.relay.start();
    c.request('second');
    expect(h.relay.state).toBe('signed-in');
    expect(signedIn).toHaveBeenCalledTimes(2);
    h.frame('live');
    expect(h.events.some((e) => e.type === 'discord-login-frame')).toBe(false);
    await vi.waitFor(() => expect(h.events.at(-1)).toEqual({ type: 'discord-login-relay', running: false }));
  });
});

describe('relayed input', () => {
  it('takes only well-formed pointer, wheel, key and text events', () => {
    expect(normalizeRelayInput({ kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 9 })).toEqual({ kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 3 });
    expect(normalizeRelayInput({ kind: 'mouse', type: 'mouseWheel', x: 1, y: 2 })).toBeNull();
    expect(normalizeRelayInput({ kind: 'mouse', type: 'mouseMoved', x: Number.NaN, y: 2 })).toBeNull();
    expect(normalizeRelayInput({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 1e9 })).toBeNull();
    expect(normalizeRelayInput({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', keyCode: 13 })).toEqual({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', keyCode: 13 });
    expect(normalizeRelayInput({ kind: 'text', text: '' })).toBeNull();
    expect(normalizeRelayInput({ kind: 'text', text: 'x'.repeat(5000) })).toBeNull();
    expect(normalizeRelayInput({ kind: 'eval', code: 'x' })).toBeNull();
    expect(normalizeRelayInput(null)).toBeNull();
  });
});
