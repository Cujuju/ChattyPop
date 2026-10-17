import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';
import { IS_LINUX } from './platform';
import { profilePath } from './storageLocation';

/** Profile folder of files encrypted by the OS keystore (DPAPI on Windows: only this account can read them). */
export const SECRETS_DIR = 'secrets';

const secretPath = (file: string): string => profilePath(SECRETS_DIR, file);

type LinuxBackend = ReturnType<typeof safeStorage.getSelectedStorageBackend>;
/** Whether each Linux backend protects secrets. basic_text encrypts with a fixed, public password; unknown means none was chosen. */
const LINUX_BACKEND_PROTECTS: Record<LinuxBackend, boolean> = {
  basic_text: false,
  unknown: false,
  gnome_libsecret: true,
  kwallet: true,
  kwallet5: true,
  kwallet6: true,
};

/** Checks OS encryption protects secrets before storing one; existing files stay readable, since refusing reads would not protect them. */
export function requireSecretStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable, so the key cannot be stored safely.');
  if (IS_LINUX && !LINUX_BACKEND_PROTECTS[safeStorage.getSelectedStorageBackend()]) {
    throw new Error('No OS keyring is available, so the key cannot be stored safely. Set up and unlock GNOME Keyring or KWallet, then restart ChattyPop.');
  }
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
