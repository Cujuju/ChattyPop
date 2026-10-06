// The installed-plugins folder as installs see it (docs/plugin-architecture.md §16): complete, checked builds staged in
// `.staged/<id>`, removal markers in `.removed/<id>`. The boot applies both at the next start.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstalledEntry } from '@shared/marketplace';
import { PLUGIN_ID_PATTERN } from '@shared/plugins';
import {
  HELD_DIR,
  INSTALLED_MANIFEST_FILE,
  INSTALLED_SOURCE_FILE,
  REMOVED_DIR,
  STAGED_DIR,
  manifestFiles,
  parseInstalledManifest,
  sdkMismatch,
  type InstalledManifest,
  type InstalledPlugin,
  type InstalledSource,
} from '@shared/installedPlugins';
import { readInstalledPlugin } from '../plugins/installed/read';

/** Inside installed-plugins: this process's work folders (downloads, unpacking, builds, discarded copies). Same volume, so staging is a rename. */
export const INCOMING_DIR = '.incoming';

/** What the index promises about a build; a mismatch is refused. */
export interface Expected {
  id: string;
  version?: string;
}

export class InstalledFolder {
  /** `rename` is injectable so a failed swap can be tested. */
  constructor(
    readonly root: string,
    /** A leftover that couldn't be deleted (a file held open); it stays in `.incoming` for the next start's clear. */
    private readonly leftoverFailed: (path: string, err: unknown) => void,
    private readonly rename: (from: string, to: string) => void = renameSync,
  ) {}

  private at = (...parts: string[]): string => join(this.root, ...parts);

  /** Deletes work folders a crash left behind; call only while no install runs. */
  clearIncoming(): void {
    this.removeLeftover(this.at(INCOMING_DIR));
  }

  /** Deletes discarded work. Never throws: what it leaves is only disk space, cleared at the next start. */
  removeLeftover(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      this.leftoverFailed(path, err);
    }
  }

  /** A fresh work folder; the caller deletes it. */
  workDir(): string {
    mkdirSync(this.at(INCOMING_DIR), { recursive: true });
    return mkdtempSync(this.at(INCOMING_DIR, 'w-'));
  }

  /** Moves `dir` out of the way, then deletes it; a failed delete leaves it in `.incoming` for the next clear. */
  private discard(dir: string): void {
    const gone = join(this.workDir(), 'gone');
    this.rename(dir, gone);
    this.removeLeftover(dirname(gone));
  }

  /** Validates builds and stages replacements with source metadata. Held copies restore failed swaps and recover crashes; successful staging cancels pending removal. */
  stage(dir: string, expected: Expected | null, source: InstalledSource): InstalledManifest {
    const manifest = checkBuild(dir, expected);
    writeFileSync(join(dir, INSTALLED_SOURCE_FILE), JSON.stringify(source, null, 2));
    mkdirSync(this.at(STAGED_DIR), { recursive: true });
    const staged = this.at(STAGED_DIR, manifest.id);
    const held = existsSync(staged) ? this.at(HELD_DIR, manifest.id) : null;
    if (held) {
      mkdirSync(this.at(HELD_DIR), { recursive: true });
      this.removeLeftover(held); // One an earlier swap couldn't delete; its replacement is the staged copy.
      this.rename(staged, held);
    }
    try {
      this.rename(dir, staged);
    } catch (err) {
      if (held) {
        this.rename(held, staged); // Failed restoration retries at next startup.
      }
      throw err;
    }
    rmSync(this.at(REMOVED_DIR, manifest.id), { force: true });
    if (held) this.removeLeftover(held); // Left behind, the next start deletes it: its replacement is staged.
    return manifest;
  }

  /** Drops a staged install and marks an installed plugin for removal; throws when it is neither. */
  uninstall(id: string): void {
    checkId(id);
    const staged = this.at(STAGED_DIR, id);
    const wasStaged = existsSync(staged);
    if (wasStaged) this.discard(staged);
    if (existsSync(this.at(id))) {
      mkdirSync(this.at(REMOVED_DIR), { recursive: true });
      writeFileSync(this.at(REMOVED_DIR, id), '');
    } else if (!wasStaged) throw new Error(`${id} isn't installed.`);
  }

  /** Drops a staged install or update and a removal marker; the next start leaves the plugin as it runs now. */
  cancel(id: string): void {
    checkId(id);
    const staged = this.at(STAGED_DIR, id);
    if (existsSync(staged)) this.discard(staged);
    rmSync(this.at(REMOVED_DIR, id), { force: true });
  }

  /** Every installed, staged or removal-marked plugin, by id. */
  entries(): InstalledEntry[] {
    const ids = new Set([...pluginDirs(this.root), ...pluginDirs(this.at(STAGED_DIR))]);
    return [...ids].sort().map((id) => {
      const current = readBuild(this.at(id));
      const staged = readBuild(this.at(STAGED_DIR, id));
      const removing = existsSync(this.at(id)) && existsSync(this.at(REMOVED_DIR, id));
      // As the boot applies them: removal first, then a staged copy installs, so a staged copy wins when both exist.
      const pending: InstalledEntry['pending'] = staged?.source
        ? { kind: 'install', version: staged.manifest.version, source: staged.source }
        : removing
          ? { kind: 'remove' }
          : null;
      const name = current?.manifest.name ?? staged?.manifest.name ?? id;
      return { id, name, version: current?.manifest.version ?? null, source: current?.source ?? null, pending };
    });
  }
}

/** plugin.json checked as the loader will (format, sdk, entry files present) and against what the index promises. */
export function checkBuild(dir: string, expected: Expected | null): InstalledManifest {
  const file = join(dir, INSTALLED_MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`The build has no ${INSTALLED_MANIFEST_FILE} at its root.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${INSTALLED_MANIFEST_FILE} is not valid JSON.`);
  }
  const m = parseInstalledManifest(raw);
  if (expected && m.id !== expected.id) throw new Error(`The build is plugin ${m.id}, not ${expected.id}.`);
  if (expected?.version !== undefined && m.version !== expected.version) throw new Error(`The build is ${m.id} ${m.version}, not ${expected.version}.`);
  const mismatch = sdkMismatch(m.sdk);
  if (mismatch) throw new Error(`${m.id} ${m.version}: ${mismatch}`);
  for (const f of manifestFiles(m)) {
    if (!isFile(join(dir, f))) throw new Error(`${m.id}: ${INSTALLED_MANIFEST_FILE} names ${f}, which the build lacks.`);
  }
  return m;
}

function checkId(id: string): void {
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`"${id}" is not a plugin id.`);
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** Folders in `dir` named like a plugin id (dot folders are the layout's own). */
function pluginDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PLUGIN_ID_PATTERN.test(e.name))
    .map((e) => e.name);
}

/** A build's manifest and source, as the start reads them; null when absent or unreadable. */
function readBuild(dir: string): InstalledPlugin | null {
  try {
    return readInstalledPlugin(dir);
  } catch {
    return null;
  }
}
