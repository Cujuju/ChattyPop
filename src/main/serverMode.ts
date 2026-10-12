// Server mode's pairing: the tray's "Pair a device…" and --pair. The phone transport makes the code; the tray opens its
// Settings section on the server's screen (the app's own themed window), and --pair prints it to the terminal.
import { timeFormat } from '@shared/hourCycle';
import { MS_PER_S } from '@shared/units';
import type { PairingPrompt } from './phone/hub';

/** How often --pair asks again while the transport is still starting (its plugin turning on, Tailscale publishing). */
const PAIR_RETRY_MS = 2 * MS_PER_S;
/** How long --pair keeps asking before it says why there is no code. */
const PAIR_WAIT_MS = 60 * MS_PER_S;

/** What a device needs to pair: the code, where to type it, and until when. */
export function pairingText(prompt: PairingPrompt): string {
  const until = timeFormat({ hour: '2-digit', minute: '2-digit' }).format(prompt.expiresAt);
  const origin = prompt.url ? new URL(prompt.url).origin : null;
  const where = origin
    ? [`On another computer, connect the ChattyPop app to ${origin} (or open ${origin}/desktop in a browser) and type the code.`, `On a phone, open ${prompt.url}.`]
    : ['This server isn’t published yet: check Settings → Phone.'];
  return [`Pairing code: ${prompt.code}`, ...where, `It works once, until ${until}.`].join('\n');
}

/** Why there is no code: no transport serves devices yet. */
export const NO_TRANSPORT_TEXT = 'Nothing serves other devices yet. Open ChattyPop from this menu and turn on Settings → Phone.';

/**
 * Asks the transport for a code until it has one or `waitMs` pass (none: asks once); `show` gets the code's text, or
 * why there is none.
 */
export async function showPairing(
  startPairing: () => Promise<PairingPrompt | null>,
  show: (text: string) => void,
  waitMs = 0,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let waited = 0; ; waited += PAIR_RETRY_MS) {
    const prompt = await startPairing().catch(() => null);
    if (prompt) return show(pairingText(prompt));
    if (waited >= waitMs) return show(NO_TRANSPORT_TEXT);
    await wait(PAIR_RETRY_MS);
  }
}

/** Where the server's tray goes to pair a device: the transport's Settings section with a new code, else none to open. */
export interface PairingScreen {
  /** Brings the main window forward. */
  raise(): void;
  openSettings(section: string): void;
  /** No transport serves devices: a system notification says so (the window is up). */
  tell(text: string): void;
}

/** The tray's "Pair a device…": a new code in the transport's own Settings section, in the server's window. */
export async function pairOnScreen(startPairing: () => Promise<PairingPrompt | null>, screen: PairingScreen): Promise<void> {
  const prompt = await startPairing().catch(() => null);
  screen.raise();
  if (prompt?.settingsSection) screen.openSettings(prompt.settingsSection);
  else if (!prompt) screen.tell(NO_TRANSPORT_TEXT);
}

/** --pair: a server started from a terminal prints its code there, once the transport serves. */
export const printPairing = (startPairing: () => Promise<PairingPrompt | null>, print: (text: string) => void): Promise<void> =>
  showPairing(startPairing, print, PAIR_WAIT_MS);
