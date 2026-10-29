import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { deleteSecret, readSecret, requireSecretStorage, writeSecret } from './secretFile';
import type { StorageConfig } from './storageLocation';

/**
 * Archive keys, encrypted by the OS keystore (DPAPI: only this Windows account can read them).
 *
 * Invariant: a key is deleted only when no archive folder bound to it remains. A folder is bound before any file
 * there can use the key (a new key before the rekey; a move's target before the copy), and unbound only once its
 * file reads as plaintext or its archive files are deleted. So no step, nor a crash between steps, deletes a key a
 * copy needs, whatever storage.json says.
 */
const KEYRING_FILE = 'archive-keys.json';
/** The pre-keyring single key. Older builds read it as the current archive's key, so it mirrors that key. */
const LEGACY_KEY_FILE = 'archive.key';
/** 256 bits: the cipher's full key strength. */
const KEY_BYTES = 32;

interface RingKey {
  /** Base64url: safe inside a PRAGMA string literal. */
  key: string;
  /** Archive folders whose database may be encrypted with this key. */
  dirs: string[];
}

const folder = (dir: string): string => resolve(dir);

const isRing = (v: unknown): v is RingKey[] =>
  Array.isArray(v) &&
  v.every((k: Partial<RingKey>) => typeof k?.key === 'string' && Array.isArray(k.dirs) && k.dirs.every((d) => typeof d === 'string'));

/** Throws when the ring exists but can't be read (another account, damage): callers must then change nothing. */
function readRing(): RingKey[] {
  const text = readSecret(KEYRING_FILE);
  if (text === null) return [];
  const ring: unknown = JSON.parse(text);
  if (!isRing(ring)) throw new Error('The archive keyring is damaged.');
  return ring;
}

function writeRing(ring: RingKey[]): void {
  if (ring.length) writeSecret(KEYRING_FILE, JSON.stringify(ring));
  else deleteSecret(KEYRING_FILE);
}

/** Keys that may open the archive in `dir`: those bound to it first, then every other stored key. Throws when one can't be read. */
export function archiveKeysFor(dir: string): string[] {
  const here = folder(dir);
  const ring = readRing();
  const keys = [...ring.filter((k) => k.dirs.includes(here)), ...ring.filter((k) => !k.dirs.includes(here))].map((k) => k.key);
  const legacy = readSecret(LEGACY_KEY_FILE);
  return legacy === null || keys.includes(legacy) ? keys : [...keys, legacy];
}

/** Adds a key an older build stored alone, bound to the folders that build may have encrypted with it. */
function adoptLegacyArchiveKey(dirs: readonly string[]): void {
  const legacy = readSecret(LEGACY_KEY_FILE);
  if (legacy === null) return;
  const ring = readRing();
  if (ring.some((k) => k.key === legacy)) return;
  writeRing([...ring, { key: legacy, dirs: [...new Set(dirs.map(folder))] }]);
}

/** Startup: adopts an older build's lone key, then lists the keys for the archive. A read failure is reported, not thrown. */
export function startupArchiveKeys({ archiveDir, previousDir }: StorageConfig, report: (event: string, err: unknown) => void): string[] {
  try {
    // An older build's lone key may be in use here or by the copy a move left behind.
    adoptLegacyArchiveKey(previousDir ? [archiveDir, previousDir] : [archiveDir]);
  } catch (err) {
    report('archive-key-adopt-failed', err);
  }
  try {
    return archiveKeysFor(archiveDir);
  } catch (err) {
    // Another Windows account, or a damaged key file: an encrypted archive can't be opened, and core reports why.
    report('archive-key-unreadable', err);
    return [];
  }
}

/** Makes a key bound to `dir` and stores it before returning it: the rekey that uses it comes after. */
export function createArchiveKey(dir: string): string {
  requireSecretStorage();
  const key = randomBytes(KEY_BYTES).toString('base64url');
  writeRing([...readRing(), { key, dirs: [folder(dir)] }]);
  writeSecret(LEGACY_KEY_FILE, key);
  return key;
}

/** Before copying the archive from `from` to `to`: the copy may need every key the original may. */
export function bindArchiveCopy(from: string, to: string): void {
  const source = folder(from);
  const target = folder(to);
  const ring = readRing();
  if (!ring.some((k) => k.dirs.includes(source) && !k.dirs.includes(target))) return;
  writeRing(ring.map((k) => (k.dirs.includes(source) && !k.dirs.includes(target) ? { ...k, dirs: [...k.dirs, target] } : k)));
}

/** No file in `dir` needs a key any more (its archive files are deleted): unbinds it, deleting keys left unbound. */
export function releaseArchiveKeys(dir: string): void {
  const gone = folder(dir);
  const ring = readRing();
  if (!ring.some((k) => k.dirs.includes(gone))) return;
  writeRing(ring.map((k) => ({ ...k, dirs: k.dirs.filter((d) => d !== gone) })).filter((k) => k.dirs.length > 0));
}

/** The archive in use, in `dir`, read as plaintext: releases its folder and clears the legacy file, unless that holds the only copy of a key. */
export function releasePlaintextArchive(dir: string): void {
  const held = readRing().map((k) => k.key);
  releaseArchiveKeys(dir);
  const legacy = readSecret(LEGACY_KEY_FILE);
  if (legacy !== null && held.includes(legacy)) deleteSecret(LEGACY_KEY_FILE);
}
