import { PLUGIN_ID_SOURCE } from './plugins';
import type { ProviderId } from './aiSettings';

/** Separates a declaration from an account key; never valid in a declared id. */
export const ACCOUNT_SEPARATOR = '@';
export const ACCOUNT_AUTHS = ['signIn', 'apiKey'] as const;
export type AccountAuth = (typeof ACCOUNT_AUTHS)[number];
export type ProviderAuth = 'cli' | AccountAuth;
export interface ProviderAccountSettings { id: ProviderId; auth: AccountAuth }
export const isAccountAuth = (value: unknown): value is AccountAuth => (ACCOUNT_AUTHS as readonly unknown[]).includes(value);

/** Account keys are safe folder names, DOM ids and preference keys. */
export const ACCOUNT_KEY_SOURCE = '[a-z0-9]+';
export const ACCOUNT_KEY = new RegExp(`^${ACCOUNT_KEY_SOURCE}$`);
export const DECLARED_PROVIDER_SOURCE = `${PLUGIN_ID_SOURCE}(\\.[a-zA-Z][a-zA-Z0-9_]*)?`;
export const DECLARED_PROVIDER_ID = new RegExp(`^${DECLARED_PROVIDER_SOURCE}$`);
export const ACCOUNT_ID = new RegExp(`^${DECLARED_PROVIDER_SOURCE}${ACCOUNT_SEPARATOR}${ACCOUNT_KEY_SOURCE}$`);
export const REMOVED_ACCOUNT = 'That account was removed in Settings → AI.';

/** Rejects malformed ids before extracting a declaration or a folder key. */
export function accountProvider(id: ProviderId): ProviderId {
  if (DECLARED_PROVIDER_ID.test(id)) return id;
  if (!ACCOUNT_ID.test(id)) throw new TypeError('Invalid AI provider id.');
  return id.slice(0, id.indexOf(ACCOUNT_SEPARATOR));
}
export function accountKey(id: ProviderId): string | null {
  accountProvider(id);
  const separator = id.indexOf(ACCOUNT_SEPARATOR);
  return separator < 0 ? null : id.slice(separator + ACCOUNT_SEPARATOR.length);
}

/** Generates an unused account id without reusing a removed account's identity. */
export function newAccountId(declaredId: ProviderId, taken: readonly ProviderId[]): ProviderId {
  if (!DECLARED_PROVIDER_ID.test(declaredId)) throw new TypeError('Expected a declared AI provider id.');
  let id: ProviderId;
  const plugin = declaredId.split('.')[0];
  const keys = new Set(taken.filter((existing) => accountProvider(existing).split('.')[0] === plugin).map(accountKey));
  do { id = `${declaredId}${ACCOUNT_SEPARATOR}${crypto.randomUUID().replaceAll('-', '')}`; } while (keys.has(accountKey(id)));
  return id;
}
