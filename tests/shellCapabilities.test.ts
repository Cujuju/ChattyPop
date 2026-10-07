// The page offers a native feature only when the installed app lists it: an older build, a browser or a malformed global offers none.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_CAPABILITIES, SHELL_NATIVE_GLOBAL, shellCapabilities, shellHas, shellThumbUrl, SHELL_THUMB_PX_MAX } from '@shared/shell';

const ALL = Object.values(SHELL_CAPABILITIES);
const SWIFT = readFileSync(join(import.meta.dirname, '../ios/App/App/ShellViewController.swift'), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('shellCapabilities', () => {
  it('reads the names the app lists', () => {
    expect([...shellCapabilities({ capabilities: [SHELL_CAPABILITIES.camera, SHELL_CAPABILITIES.photoLibrary] })]).toEqual([
      SHELL_CAPABILITIES.camera,
      SHELL_CAPABILITIES.photoLibrary,
    ]);
  });

  it('gives none to a browser, a build that predates the list, or a malformed global', () => {
    for (const shell of [undefined, null, 'camera', {}, { apsEnvironment: 'development' }, { capabilities: 'camera' }, { capabilities: {} }]) {
      expect(shellCapabilities(shell).size).toBe(0);
    }
  });

  it('drops names it does not know and non-strings', () => {
    expect([...shellCapabilities({ capabilities: ['teleport', 7, null, SHELL_CAPABILITIES.network] })]).toEqual([SHELL_CAPABILITIES.network]);
  });

  it('reads the app global by default', () => {
    expect(shellHas(SHELL_CAPABILITIES.camera)).toBe(false);
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: [SHELL_CAPABILITIES.camera] });
    expect(shellHas(SHELL_CAPABILITIES.camera)).toBe(true);
    expect(shellHas(SHELL_CAPABILITIES.photoLibrary)).toBe(false);
  });

  it('is what this checkout\'s app lists, and nothing it does not know', () => {
    const listed = /static let capabilities = \[([^\]]*)\]/.exec(SWIFT)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1));
    expect(listed?.sort()).toEqual([...ALL].sort());
  });
});

describe('shellThumbUrl', () => {
  it('encodes PhotoKit identifiers and clamps the side', () => {
    expect(shellThumbUrl('ABC/L0/001', 240)).toBe('chattypop-asset://thumb/ABC%2FL0%2F001?px=240');
    expect(shellThumbUrl('a', 0)).toBe('chattypop-asset://thumb/a?px=1');
    expect(shellThumbUrl('a', SHELL_THUMB_PX_MAX * 2)).toBe(`chattypop-asset://thumb/a?px=${SHELL_THUMB_PX_MAX}`);
  });
});
