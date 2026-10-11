// The server's Discord sign-in as a remote desktop sees it: whether the server's client is signed in, and a sign-in
// relay's frames (shared/discordLogin.ts). Off the server's screen only; the server's own window shows the live client.
import { createSignal } from 'solid-js';
import { api } from '@/api';
import { createPushedValue, onAppEvent } from './events';
import type { DiscordSessionState, LoginFrame, RelayInput } from '@shared/discordLogin';

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
