import type { SecretFiles } from './plugins/context';

/** All provider API keys as one encrypted JSON object, by provider id. */
export const PROVIDER_KEYS_FILE = 'provider.keys';

/** Missing, malformed or unreadable storage contains no usable keys. */
export function loadProviderKeys(secrets: SecretFiles): Record<string, string> {
  try {
    const stored = secrets.read(PROVIDER_KEYS_FILE);
    if (stored === null) return {};
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value);
    if (entries.some(([, key]) => typeof key !== 'string' || !key.trim())) return {};
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveProviderKey(secrets: SecretFiles, id: string, key: string): Record<string, string> {
  const keys = { ...loadProviderKeys(secrets), [id]: key };
  secrets.write(PROVIDER_KEYS_FILE, JSON.stringify(keys));
  return keys;
}

export function forgetProviderKey(secrets: SecretFiles, id: string): Record<string, string> {
  const keys = loadProviderKeys(secrets);
  delete keys[id];
  secrets.write(PROVIDER_KEYS_FILE, JSON.stringify(keys));
  return keys;
}
