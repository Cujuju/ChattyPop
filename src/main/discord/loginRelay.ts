// Signs the server's Discord client in from another machine (shared/discordLogin.ts): while a relay runs the server
// shows its window (without focus) with the Discord page over it, streams the page as CDP screencast frames, and
// replays the owner's pointer and keys as CDP input. A hidden window paints nothing, so there is nothing to stream.
import type { BrowserWindow, WebContents } from 'electron';
import type { AppEvent } from '@shared/contract';
import type { DiscordSessionState, LoginFrame, LoginRelayState, RelayInput } from '@shared/discordLogin';
import { errorMessage } from '@shared/errors';
import { MS_PER_MIN } from '@shared/units';
import type { HeaderCapture } from './capture';

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

/** What says whether the client is signed in: its page, and the token captured from its requests. */
export interface SessionSignals {
  page: { onLoginPage: ((atLogin: boolean) => void) | undefined };
  capture: Pick<HeaderCapture, 'invalidate' | 'onAvailable'>;
}

/**
 * Keeps the relay's session state through every sign-out and sign-in. The login page means signed out and voids the
 * captured token, so the next token the client sends is a sign-in (`signedIn`), whether or not one was held before.
 */
export function followSession(relay: LoginRelay, { page, capture }: SessionSignals, signedIn: () => void): void {
  page.onLoginPage = (atLogin) => {
    if (!atLogin) return;
    capture.invalidate();
    relay.setState('signed-out');
  };
  capture.onAvailable = () => {
    relay.setState('signed-in');
    signedIn();
  };
}

export class LoginRelay {
  private sessionState: DiscordSessionState = 'unknown';
  private running = false;
  /** Whether the relay showed the window, so stopping hides it again. */
  private shown = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The running relay's latest frame; null before its first, and once it stops. */
  private lastFrame: LoginFrame | null = null;
  /** Starts and stops run one at a time, so a stop still finishing never dismantles the relay started after it. */
  private turn: Promise<void> = Promise.resolve();

  constructor(private readonly d: LoginRelayDeps) {
    d.view.webContents.debugger.on('message', (_e, method, params) => {
      if (method !== 'Page.screencastFrame' || !this.relaying) return;
      const frame = params as ScreencastFrame;
      void this.command('Page.screencastFrameAck', { sessionId: frame.sessionId });
      this.lastFrame = { data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight };
      d.emit({ type: 'discord-login-frame', ...this.lastFrame });
    });
  }

  get state(): DiscordSessionState {
    return this.sessionState;
  }

  /** The relay as a page that just loaded finds it; a still page sends no new frame, so the latest one comes with it. */
  get relayState(): LoginRelayState {
    return this.relaying ? { running: true, frame: this.lastFrame } : { running: false, frame: null };
  }

  /**
   * A relay is for signing in: frames leave and input arrives only while one runs and the client is signed out. A
   * signed-in page is the owner's live Discord, which no remote desktop sees or drives.
   */
  private get relaying(): boolean {
    return this.running && this.sessionState === 'signed-out';
  }

  /** The Discord page or its requests say whether it is signed in; anything but signed out ends a relay. */
  setState(state: DiscordSessionState): void {
    if (state === this.sessionState) return;
    this.sessionState = state;
    this.d.emit({ type: 'discord-session', state });
    if (state !== 'signed-out') void this.stop();
  }

  /** Refused unless the client is signed out. */
  start(): Promise<void> {
    return this.inTurn(async () => {
      if (this.running) return;
      if (this.sessionState !== 'signed-out') throw new Error("The server's Discord client isn't at its sign-in page.");
      this.running = true;
      this.shown = !this.d.win.isVisible();
      if (this.shown) this.d.win.showInactive();
      this.d.view.holdForRelay(true);
      this.timer = setTimeout(() => void this.stop(), RELAY_MAX_MS);
      this.d.emit({ type: 'discord-login-relay', running: true });
      await this.command('Page.startScreencast', SCREENCAST);
    });
  }

  stop(): Promise<void> {
    return this.inTurn(async () => {
      if (!this.running) return;
      this.running = false;
      this.lastFrame = null;
      clearTimeout(this.timer);
      await this.command('Page.stopScreencast');
      this.d.view.holdForRelay(false);
      if (this.shown && !this.d.win.isDestroyed()) this.d.win.hide();
      this.shown = false;
      this.d.emit({ type: 'discord-login-relay', running: false });
    });
  }

  /** Runs `step` after every start and stop asked for before it; its failure is the caller's, not the next step's. */
  private inTurn(step: () => Promise<void>): Promise<void> {
    const done = this.turn.then(step);
    this.turn = done.catch(() => undefined);
    return done;
  }

  /** Replays the owner's pointer or keys on the page; nothing unless a relay is signing in. */
  async input(e: RelayInput): Promise<void> {
    if (!this.relaying) return;
    if (e.kind === 'mouse') {
      await this.command('Input.dispatchMouseEvent', { type: e.type, x: e.x, y: e.y, button: e.button, buttons: e.type === 'mouseReleased' ? 0 : PRESSED[e.button], clickCount: e.clickCount, modifiers: e.modifiers });
    } else if (e.kind === 'wheel') {
      await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: e.modifiers });
    } else if (e.kind === 'key') {
      await this.command('Input.dispatchKeyEvent', { type: e.type, key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: e.modifiers, ...(e.text ? { text: e.text } : {}) });
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
