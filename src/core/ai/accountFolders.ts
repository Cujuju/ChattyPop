import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ACCOUNT_KEY, ACCOUNT_SEPARATOR, accountKey, accountProvider } from '@shared/providerAccounts';

export const ACCOUNTS_DIR = 'accounts';
/** Windows CLI exits can leave short-lived file locks. Failed removals are swept at the next activation. */
const DELETE_RETRIES = 5;
const DELETE_RETRY_DELAY_MS = 100;
const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
};

export function accountDir(dataDir: string, id: string): string {
  const key = accountKey(id);
  if (!key) throw new Error('Expected an account id.');
  return join(dataDir, ACCOUNTS_DIR, key);
}

/** Refuses a redirected accounts root; child symlinks are removed themselves, never followed. */
async function guardedRoot(dataDir: string): Promise<string | null> {
  const root = resolve(dataDir, ACCOUNTS_DIR);
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('The accounts folder must not be a symbolic link.');
    if (!inside(await realpath(dataDir), await realpath(root))) throw new Error('Account folder escaped plugin storage.');
    return root;
  } catch (err) { if (missing(err)) return null; throw err; }
}

export async function removeAccountDir(dataDir: string, id: string): Promise<void> {
  const target = resolve(accountDir(dataDir, id));
  const root = await guardedRoot(dataDir);
  if (!root) return;
  if (!inside(root, target)) throw new Error('Account folder escaped accounts storage.');
  await rm(target, { recursive: true, force: true, maxRetries: DELETE_RETRIES, retryDelay: DELETE_RETRY_DELAY_MS });
}

/** Detaches a child link before invoking a CLI that would otherwise follow it during logout. */
export async function prepareAccountRemoval(dataDir: string, id: string): Promise<void> {
  const target = resolve(accountDir(dataDir, id));
  const root = await guardedRoot(dataDir);
  if (!root) return;
  if (!inside(root, target)) throw new Error('Account folder escaped accounts storage.');
  try {
    if ((await lstat(target)).isSymbolicLink()) await rm(target, { force: true });
  } catch (err) { if (!missing(err)) throw err; }
}

export async function orphanAccountIds(dataDir: string, provider: string, kept: readonly string[]): Promise<string[]> {
  const root = await guardedRoot(dataDir);
  if (!root) return [];
  const plugin = provider.split('.')[0];
  const keptKeys = new Set(kept.filter((id) => accountProvider(id).split('.')[0] === plugin).map(accountKey));
  return (await readdir(root)).filter((key) => ACCOUNT_KEY.test(key) && !keptKeys.has(key)).map((key) => `${provider}${ACCOUNT_SEPARATOR}${key}`);
}
