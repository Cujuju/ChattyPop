import { randomUUID } from 'node:crypto';
import { keyHint, validateKeyRouting, type OpenRouterKeyEntry, type OpenRouterKeyRouting } from '@shared/openrouter';
import { deleteSecret, readSecret, writeSecret } from './secretFile';

/** All keys and their routing, as one encrypted JSON array. */
const KEYS_FILE = 'openrouter.keys';
/** The single key stored before multi-key support; migrated on first read. */
const LEGACY_KEY_FILE = 'openrouter.key';
const LEGACY_LABEL = 'OpenRouter key';

const write = (keys: OpenRouterKeyEntry[]): void => writeSecret(KEYS_FILE, JSON.stringify(keys));

/**
 * Stored keys, decrypted with the OS keystore (DPAPI on Windows); empty when none or unreadable.
 * A legacy single key becomes one key paying for any model, which is how it was used.
 */
export function loadOpenRouterKeys(): OpenRouterKeyEntry[] {
  try {
    const stored = readSecret(KEYS_FILE);
    if (stored !== null) return JSON.parse(stored) as OpenRouterKeyEntry[];
    const key = readSecret(LEGACY_KEY_FILE);
    if (key === null) return [];
    const keys = [{ id: randomUUID(), label: LEGACY_LABEL, key, hint: keyHint(key), models: [], anyModel: true }];
    write(keys);
    deleteSecret(LEGACY_KEY_FILE);
    return keys;
  } catch {
    return [];
  }
}

/** Adds a key already checked with OpenRouter. With no routing given, it pays for any model if no key does yet. */
export function addOpenRouterKey(key: string, routing: OpenRouterKeyRouting | null): OpenRouterKeyEntry[] {
  const keys = loadOpenRouterKeys();
  if (keys.some((k) => k.key === key)) throw new Error('That key is already stored.');
  const r = routing ?? { label: `OpenRouter key ${keys.length + 1}`, models: [], anyModel: !keys.some((k) => k.anyModel) };
  const next = [...keys, { id: randomUUID(), key, hint: keyHint(key), ...clean(r) }];
  validateKeyRouting(next);
  write(next);
  return next;
}

export function updateOpenRouterKey(id: string, routing: OpenRouterKeyRouting): OpenRouterKeyEntry[] {
  const keys = loadOpenRouterKeys();
  if (!keys.some((k) => k.id === id)) throw new Error('That key is no longer stored.');
  const next = keys.map((k) => (k.id === id ? { ...k, ...clean(routing) } : k));
  validateKeyRouting(next);
  write(next);
  return next;
}

export function removeOpenRouterKey(id: string): OpenRouterKeyEntry[] {
  const next = loadOpenRouterKeys().filter((k) => k.id !== id);
  write(next);
  return next;
}

const clean = (r: OpenRouterKeyRouting): OpenRouterKeyRouting => ({ label: r.label.trim(), models: [...new Set(r.models)], anyModel: r.anyModel });
