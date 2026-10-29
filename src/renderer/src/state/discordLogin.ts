// The server's Discord sign-in as a remote desktop sees it: whether the server's client is signed in, and a sign-in
// relay's frames (shared/discordLogin.ts). Off the server's screen only; the server's own window shows the live client.
import { createSignal } from 'solid-js';
import { api } from '@/api';
import { createPushedValue, onAppEvent } from './events';
import { relayModifiers, type DiscordSessionState, type LoginFrame, type RelayInput } from '@shared/discordLogin';

const session = createPushedValue(() => api.discord.loginState(), 'discord-session', (e) => e.state);
/** Whether the server's Discord client is signed in; unknown while loading. */
export const discordSession = (): DiscordSessionState => session.value() ?? 'unknown';

/** Whether a sign-in relay runs (one may run for another of the owner's devices): read at load, then pushed. */
export const [relayRunning, setRelayRunning] = createSignal(false);
/** The owner chose to read the archive without signing in, this visit. */
export const [signInDismissed, setSignInDismissed] = createSignal(false);
/** The relay's latest frame; null while none runs. */
export const [loginFrame, setLoginFrame] = createSignal<LoginFrame | null>(null);

/** Set once the server pushed the relay's state: what the page read at load is older than that. */
let pushed = false;
onAppEvent('discord-login-relay', (e) => {
  pushed = true;
  setRelayRunning(e.running);
  if (!e.running) setLoginFrame(null);
});
// Only a running relay sends frames, so one says a relay runs.
onAppEvent('discord-login-frame', ({ data, width, height }) => {
  pushed = true;
  setRelayRunning(true);
  setLoginFrame({ data, width, height });
});
// A page that loads while a relay runs (a reload, or another device's relay) shows it. A server older than this call
// refuses it, and the page waits for the events as before.
void api.discord.loginRelayState().then(
  (relay) => {
    if (pushed) return;
    setRelayRunning(relay.running);
    setLoginFrame(relay.frame);
  },
  () => undefined,
);

export const startRelay = (): Promise<void> => api.discord.loginStart();
export const stopRelay = (): Promise<void> => api.discord.loginStop();
/** The owner's pointer or keys on the frame; a lost one is dropped, as a lost frame is. */
export const sendRelayInput = (e: RelayInput): void => void api.discord.loginInput(e).catch(() => undefined);

/** Virtual-key codes (keyCode) of the paste shortcuts' keys; keyCode follows the layout, as the shortcut does. */
const VK_V = 86;
const VK_INSERT = 45;

/** Ctrl/Cmd+V or Shift+Insert: the platform's paste, whose paste event carries the clipboard's text. */
const isPasteShortcut = (e: KeyboardEvent): boolean =>
  !e.altKey && (((e.ctrlKey || e.metaKey) && e.keyCode === VK_V) || (e.shiftKey && !e.ctrlKey && !e.metaKey && e.keyCode === VK_INSERT));

/**
 * Relays the owner's keys on the frame, keeping them from this page. A paste shortcut is left to the browser: its paste
 * event sends the text, and neither its press nor its release is relayed.
 */
export function createKeyRelay(): (type: 'keyDown' | 'keyUp', e: KeyboardEvent) => void {
  /** Codes of keys pressed for a local paste, whose release stays local too. */
  const local = new Set<string>();
  return (type, e) => {
    if (type === 'keyDown' && isPasteShortcut(e)) return void local.add(e.code);
    if (type === 'keyUp' && local.delete(e.code)) return;
    e.preventDefault();
    // A printable key without a shortcut modifier types its character; Enter types a return.
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = type === 'keyDown' ? (printable ? e.key : e.key === 'Enter' ? '\r' : null) : null;
    sendRelayInput({ kind: 'key', type, key: e.key, code: e.code, text, keyCode: e.keyCode, modifiers: relayModifiers(e) });
  };
}
