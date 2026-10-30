import { normalizeProviderId } from '@shared/aiSettings';
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
    if (entries.some(([id, key]) => !normalizeProviderId(id) || typeof key !== 'string' || !key.trim())) return {};
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveProviderKey(secrets: SecretFiles, id: string, key: string): Record<string, string> {
  if (!normalizeProviderId(id)) throw new TypeError('Invalid AI provider id.');
  const keys = { ...loadProviderKeys(secrets), [id]: key };
  secrets.write(PROVIDER_KEYS_FILE, JSON.stringify(keys));
  return keys;
}

/** The proxy's client key (Settings → AI → Proxy), encrypted like the provider keys. */
export const PROXY_KEY_FILE = 'proxy.key';

/** The stored proxy client key; null when none or unreadable. */
export function loadProxyKey(secrets: SecretFiles): string | null {
  try {
    return secrets.read(PROXY_KEY_FILE)?.trim() || null;
  } catch {
    return null;
  }
}

export function saveProxyKey(secrets: SecretFiles, raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error('Paste the proxy client key.');
  secrets.write(PROXY_KEY_FILE, key);
  return key;
}

export function forgetProxyKey(secrets: SecretFiles): void {
  secrets.delete(PROXY_KEY_FILE);
}

export function forgetProviderKey(secrets: SecretFiles, id: string): Record<string, string> {
  if (!normalizeProviderId(id)) throw new TypeError('Invalid AI provider id.');
  const keys = loadProviderKeys(secrets);
  delete keys[id];
  secrets.write(PROVIDER_KEYS_FILE, JSON.stringify(keys));
  return keys;
}
