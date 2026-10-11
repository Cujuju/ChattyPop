// Signing the server's Discord client in from another machine (main/discord/loginRelay.ts): the window shows while
// a relay streams, frames go out as events, the owner's input comes back as CDP input, and signing in ends it.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { normalizeRelayInput } from '@shared/discordLogin';
import { LoginRelay } from '../src/main/discord/loginRelay';

function harness(visible = false) {
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async () => ({}));
  const dbg = Object.assign(debuggerEvents, { sendCommand });
  const win = { visible, isVisible: () => win.visible, showInactive: vi.fn(() => void (win.visible = true)), hide: vi.fn(() => void (win.visible = false)), isDestroyed: () => false };
  const holdForRelay = vi.fn();
  const events: AppEvent[] = [];
  const relay = new LoginRelay({ win, view: { webContents: { debugger: dbg as never }, holdForRelay }, emit: (e) => void events.push(e), diag: () => undefined });
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
    const h = harness(true);
    await h.relay.start();
    await h.relay.stop();
    expect(h.win.showInactive).not.toHaveBeenCalled();
    expect(h.win.hide).not.toHaveBeenCalled();
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
    const h = harness();
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
