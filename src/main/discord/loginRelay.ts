// Signs the server's Discord client in from another machine (shared/discordLogin.ts): while a relay runs the server
// shows its window (without focus) with the Discord page over it, streams the page as CDP screencast frames, and
// replays the owner's pointer and keys as CDP input. A hidden window paints nothing, so there is nothing to stream.
import type { BrowserWindow, WebContents } from 'electron';
import type { AppEvent } from '@shared/contract';
import type { DiscordSessionState, RelayInput } from '@shared/discordLogin';
import { errorMessage } from '@shared/errors';
import { MS_PER_MIN } from '@shared/units';

/** Frames as JPEG at this quality and width: readable text, a modest stream. */
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 2 } as const;
/** A relay nobody stops ends by itself after this. */
const RELAY_MAX_MS = 10 * MS_PER_MIN;
/** CDP's mouse buttons, as the owner pressed them. */
const PRESSED = { none: 0, left: 1, right: 2, middle: 4 } as const;

export interface LoginRelayDeps {
  win: Pick<BrowserWindow, 'isVisible' | 'showInactive' | 'hide' | 'isDestroyed'>;
  view: { webContents: Pick<WebContents, 'debugger'>; holdForRelay(on: boolean): void };
  emit(e: AppEvent): void;
  diag(event: string, detail?: Record<string, unknown>): void;
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number };
}

export class LoginRelay {
  private sessionState: DiscordSessionState = 'unknown';
  private running = false;
  /** Whether the relay showed the window, so stopping hides it again. */
  private shown = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: LoginRelayDeps) {
    d.view.webContents.debugger.on('message', (_e, method, params) => {
      if (method !== 'Page.screencastFrame' || !this.running) return;
      const frame = params as ScreencastFrame;
      void this.command('Page.screencastFrameAck', { sessionId: frame.sessionId });
      d.emit({ type: 'discord-login-frame', data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
    });
  }

  get state(): DiscordSessionState {
    return this.sessionState;
  }

  /** The Discord page or its requests say whether it is signed in; signing in ends a relay. */
  setState(state: DiscordSessionState): void {
    if (state === this.sessionState) return;
    this.sessionState = state;
    this.d.emit({ type: 'discord-session', state });
    if (state === 'signed-in') void this.stop();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.shown = !this.d.win.isVisible();
    if (this.shown) this.d.win.showInactive();
    this.d.view.holdForRelay(true);
    this.timer = setTimeout(() => void this.stop(), RELAY_MAX_MS);
    this.d.emit({ type: 'discord-login-relay', running: true });
    await this.command('Page.startScreencast', SCREENCAST);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    await this.command('Page.stopScreencast');
    this.d.view.holdForRelay(false);
    if (this.shown && !this.d.win.isDestroyed()) this.d.win.hide();
    this.shown = false;
    this.d.emit({ type: 'discord-login-relay', running: false });
  }

  /** Replays the owner's pointer or keys on the page; nothing while no relay runs. */
  async input(e: RelayInput): Promise<void> {
    if (!this.running) return;
    if (e.kind === 'mouse') {
      await this.command('Input.dispatchMouseEvent', { type: e.type, x: e.x, y: e.y, button: e.button, buttons: e.type === 'mouseReleased' ? 0 : PRESSED[e.button], clickCount: e.clickCount });
    } else if (e.kind === 'wheel') {
      await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY });
    } else if (e.kind === 'key') {
      await this.command('Input.dispatchKeyEvent', { type: e.type, key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, ...(e.text ? { text: e.text } : {}) });
    } else await this.command('Input.insertText', { text: e.text });
  }

  /** A CDP command on the Discord page's debugger (the gateway tap's attachment); a failure is logged, not thrown. */
  private async command(method: string, params?: Record<string, unknown>): Promise<void> {
    try {
      await this.d.view.webContents.debugger.sendCommand(method, params);
    } catch (err) {
      this.d.diag('login-relay-command-failed', { method, message: errorMessage(err) });
    }
  }
}
