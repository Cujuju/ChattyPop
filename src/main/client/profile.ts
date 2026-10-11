// A client's own profile: its servers, windows and each server's pairing cookie, apart from the app's (the Discord
// login and the archive), so a client runs beside the app or a server on the same computer.
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';

/** Selects the client's profile folder (absolute); else `ChattyPop Client` beside the app's. */
export const CLIENT_PROFILE_DIR_ENV = 'CHATTYPOP_CLIENT_PROFILE_DIR';
const CLIENT_PROFILE_NAME = 'ChattyPop Client';

/** Must run before app 'ready', when Electron fixes the sessions' storage paths. */
export function applyClientProfile(): void {
  const dir = process.env[CLIENT_PROFILE_DIR_ENV];
  if (dir && !isAbsolute(dir)) throw new Error(`${CLIENT_PROFILE_DIR_ENV} must be an absolute path, got "${dir}".`);
  const profile = dir || join(app.getPath('appData'), CLIENT_PROFILE_NAME);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
