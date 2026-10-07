// Main's window calls by channel, kept so the phone hub can reach those PHONE_MAIN_CALLS allows (main/phone/hub.ts).
import { ipcMain } from 'electron';

type MainCall = (...args: unknown[]) => unknown;
const calls = new Map<string, MainCall>();

/** Serves `channel` to windows and records it for the phone. Calls that read their sender register with ipcMain directly. */
export function handleMain(channel: string, fn: MainCall): void {
  calls.set(channel, fn);
  ipcMain.handle(channel, (_e, ...args: unknown[]) => fn(...args));
}

/** Runs the call registered on `channel`. */
export async function callMain(channel: string, args: readonly unknown[]): Promise<unknown> {
  const fn = calls.get(channel);
  if (!fn) throw new Error(`No main call ${channel}`);
  return await fn(...args);
}
