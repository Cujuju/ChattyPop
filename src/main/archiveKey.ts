import { randomBytes } from 'node:crypto';
import { deleteSecret, readSecret, requireSecretStorage, writeSecret } from './secretFile';

/** The archive database key, encrypted by the OS keystore (DPAPI: only this Windows account can read it). */
const KEY_FILE = 'archive.key';
/** 256 bits: the cipher's full key strength. */
const KEY_BYTES = 32;

/** The stored key, or null when the archive isn't encrypted. Throws when a key exists but can't be read (wrong account). */
export function loadArchiveKey(): string | null {
  return readSecret(KEY_FILE);
}

/** Makes and stores a new random key (base64url: safe inside a PRAGMA string literal). */
export function createArchiveKey(): string {
  requireSecretStorage();
  const key = randomBytes(KEY_BYTES).toString('base64url');
  writeSecret(KEY_FILE, key);
  return key;
}

export function deleteArchiveKey(): void {
  deleteSecret(KEY_FILE);
}
