import { appendFileSync } from 'node:fs';
import { profilePath } from './storageLocation';

/** Session-health log (auth failures, gateway closes, quit sequence). Never contains tokens or message content. */
const DIAGNOSTICS_FILE = 'diagnostics.log';

export function diag(event: string, detail: Record<string, unknown> = {}): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
  try {
    appendFileSync(profilePath(DIAGNOSTICS_FILE), line);
  } catch {
    // Diagnostics must never break the app.
  }
  console.log('[diag]', line.trimEnd());
}

/** Snowflake-length digit runs in a URL path, replaced so logs carry no ids (open-ended, unlike SNOWFLAKE_DIGITS). */
const ID_RUN = /\d{15,}/g;
export const redactIds = (path: string): string => path.replace(ID_RUN, ':id');
