import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

type Backend = 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';
const host = vi.hoisted(() => ({ linux: false, backend: 'unknown' as Backend, userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => host.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => host.backend,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}));
vi.mock('../src/main/platform', () => ({ get IS_LINUX() { return host.linux; } }));

const { SECRETS_DIR, SECRET_FILES, requireSecretStorage, writeSecret } = await import('../src/main/secretFile');
const { createArchiveKey } = await import('../src/main/archiveKey');

const FILE = 'probe.key';
const stored = (file: string): boolean => existsSync(join(host.userData, SECRETS_DIR, file));

describe('secret storage refuses Linux backends that do not protect secrets', () => {
  beforeEach(() => { host.userData = tempDir(); });

  it.each(['basic_text', 'unknown'] as const)('refuses %s on Linux before writing anything', (backend) => {
    host.linux = true;
    host.backend = backend;
    expect(requireSecretStorage).toThrow('keyring');
    expect(() => writeSecret(FILE, 'v')).toThrow('keyring');
    expect(() => SECRET_FILES.write(FILE, 'v')).toThrow('keyring');
    expect(() => createArchiveKey()).toThrow('keyring');
    expect(stored(FILE)).toBe(false);
    expect(stored('archive.key')).toBe(false);
  });

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const)('stores with %s on Linux', (backend) => {
    host.linux = true;
    host.backend = backend;
    writeSecret(FILE, 'v');
    expect(SECRET_FILES.read(FILE)).toBe('v');
  });

  it('ignores the Linux backend elsewhere', () => {
    host.linux = false;
    host.backend = 'basic_text';
    writeSecret(FILE, 'v');
    expect(SECRET_FILES.read(FILE)).toBe('v');
  });
});
