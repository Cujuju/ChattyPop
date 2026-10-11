// The server's Discord sign-in as a remote desktop sees it: whether the server's client is signed in, and a sign-in
// relay's frames (shared/discordLogin.ts). Off the server's screen only; the server's own window shows the live client.
import { createSignal } from 'solid-js';
import { api } from '@/api';
import { createPushedValue, onAppEvent } from './events';
import type { DiscordSessionState, LoginFrame, RelayInput } from '@shared/discordLogin';

const session = createPushedValue(() => api.discord.loginState(), 'discord-session', (e) => e.state);
/** Whether the server's Discord client is signed in; unknown while loading. */
export const discordSession = (): DiscordSessionState => session.value() ?? 'unknown';

/** Whether a sign-in relay runs (one may run for another of the owner's devices). */
export const [relayRunning, setRelayRunning] = createSignal(false);
/** The owner chose to read the archive without signing in, this visit. */
export const [signInDismissed, setSignInDismissed] = createSignal(false);
/** The relay's latest frame; null while none runs. */
export const [loginFrame, setLoginFrame] = createSignal<LoginFrame | null>(null);

onAppEvent('discord-login-relay', (e) => {
  setRelayRunning(e.running);
  if (!e.running) setLoginFrame(null);
});
onAppEvent('discord-login-frame', ({ data, width, height }) => setLoginFrame({ data, width, height }));

export const startRelay = (): Promise<void> => api.discord.loginStart();
export const stopRelay = (): Promise<void> => api.discord.loginStop();
/** The owner's pointer or keys on the frame; a lost one is dropped, as a lost frame is. */
export const sendRelayInput = (e: RelayInput): void => void api.discord.loginInput(e).catch(() => undefined);
