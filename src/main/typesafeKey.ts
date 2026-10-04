import { deleteSecret, readSecret, requireSecretStorage, writeSecret } from './secretFile';

/** Lists the models the key can use; free, so it checks a key without spending. */
const MODELS_URL = 'https://api.typesafe.ai/v1/models';
const KEY_CHECK_TIMEOUT_MS = 10_000;
/** TypeSafe answers an unknown key with 401 and a missing one with 403. */
const REJECTED = new Set([401, 403]);
const KEY_FILE = 'typesafe.key';

/** The stored key, decrypted with the OS keystore (DPAPI on Windows); null when none or unreadable. */
export function loadTypeSafeKey(): string | null {
  try {
    return readSecret(KEY_FILE);
  } catch {
    return null;
  }
}

/** Rejects a pasted key TypeSafe doesn't recognise, then stores it encrypted, replacing any earlier one. */
export async function saveTypeSafeKey(raw: string): Promise<string> {
  const key = raw.trim();
  if (!key) throw new Error('Paste a TypeSafe API key.');
  requireSecretStorage();
  const res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(REJECTED.has(res.status) ? 'TypeSafe rejected that key.' : `TypeSafe key check failed: HTTP ${res.status}`);
  writeSecret(KEY_FILE, key);
  return key;
}

export function forgetTypeSafeKey(): void {
  deleteSecret(KEY_FILE);
}
