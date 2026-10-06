import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';
import { profilePath } from './storageLocation';

/** Profile folder of files encrypted by the OS keystore (DPAPI on Windows: only this account can read them). */
export const SECRETS_DIR = 'secrets';

const secretPath = (file: string): string => profilePath(SECRETS_DIR, file);

/** Checks OS encryption availability before secret storage. */
export function requireSecretStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable, so the key cannot be stored safely.');
}

/** The decrypted secret; null when the file is missing. Throws when it exists but can't be decrypted (another account). */
export function readSecret(file: string): string | null {
  const path = secretPath(file);
  return existsSync(path) ? safeStorage.decryptString(readFileSync(path)) : null;
}

/** Stores `value` encrypted, replacing the file; throws when encryption is unavailable. */
export function writeSecret(file: string, value: string): void {
  requireSecretStorage();
  mkdirSync(profilePath(SECRETS_DIR), { recursive: true });
  writeFileSync(secretPath(file), safeStorage.encryptString(value));
}

export function deleteSecret(file: string): void {
  rmSync(secretPath(file), { force: true });
}

/** The profile's secret files, as plugins' main contexts keep them (`<plugin id>-<name>`). */
export const SECRET_FILES = { read: readSecret, write: writeSecret, delete: deleteSecret };
