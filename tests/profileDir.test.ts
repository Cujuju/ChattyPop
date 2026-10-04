import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

const paths = vi.hoisted(() => ({ userData: 'default-profile' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => paths.userData,
    setPath: (_name: string, dir: string) => { paths.userData = dir; },
  },
}));

const { PROFILE_DIR_ENV, applyProfileDirOverride } = await import('../src/main/storageLocation');

describe('profile directory override', () => {
  // The machine may set the variable for real (the owner's profile lives elsewhere); each test starts without it.
  beforeEach(() => {
    vi.stubEnv(PROFILE_DIR_ENV, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    paths.userData = 'default-profile';
  });

  it('keeps the default profile when unset', () => {
    applyProfileDirOverride();
    expect(paths.userData).toBe('default-profile');
  });

  it('moves the profile to the named directory, creating it', () => {
    const dir = join(tempDir(), 'profile');
    process.env[PROFILE_DIR_ENV] = dir;
    applyProfileDirOverride();
    expect(paths.userData).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('rejects a relative path instead of resolving it against the working directory', () => {
    process.env[PROFILE_DIR_ENV] = 'profile';
    expect(() => applyProfileDirOverride()).toThrow(PROFILE_DIR_ENV);
    expect(paths.userData).toBe('default-profile');
  });
});
