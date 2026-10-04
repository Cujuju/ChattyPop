// Source installs find npm only in PATH's absolute folders and run it without a shell (docs/plugin-architecture.md §16).
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmCommand } from '../src/main/marketplace/npm';

const CLI = join('node_modules', 'npm', 'bin', 'npm-cli.js');
const nodeDir = resolve('/nodejs');
const pluginDir = resolve('/profile/installed-plugins/.incoming/w-1/plugin');
/** A filesystem where `dirs` hold a node install, and the plugin folder holds its own npm, npm.cmd and node.exe. */
const fakeFs = (...dirs: string[]) => {
  const files = new Set([...dirs.flatMap((d) => [join(d, 'node.exe'), join(d, CLI), join(d, 'npm')]), ...['npm', 'npm.cmd', 'node.exe'].map((f) => join(pluginDir, f))]);
  return (file: string): boolean => files.has(file);
};

describe('npmCommand', () => {
  it('runs npm-cli.js on the node beside it on Windows, never a shell', () => {
    expect(npmCommand([nodeDir].join(delimiter), 'win32', fakeFs(nodeDir))).toEqual({ file: join(nodeDir, 'node.exe'), args: [join(nodeDir, CLI)] });
  });

  it("skips relative and empty PATH entries, so the plugin's own npm or node never runs", () => {
    const path = ['.', '', 'plugin', nodeDir].join(delimiter);
    for (const platform of ['win32', 'linux'] as const) {
      const cmd = npmCommand(path, platform, fakeFs(nodeDir, '.', 'plugin', pluginDir));
      expect(cmd?.file.startsWith(nodeDir)).toBe(true);
    }
  });

  it('is null when no absolute PATH folder holds npm', () => {
    expect(npmCommand(['.', 'bin'].join(delimiter), 'win32', fakeFs('.', 'bin'))).toBeNull();
    expect(npmCommand(nodeDir, 'win32', (f) => f === join(nodeDir, 'node.exe'))).toBeNull();
  });
});
