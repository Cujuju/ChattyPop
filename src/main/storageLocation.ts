import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';

/**
 * Names a directory for the app profile (settings, Discord login, keys, models) instead of AppData on the
 * system drive. Outside AppData it is also immune to MSIX AppData redirection when launched from a packaged app.
 */
export const PROFILE_DIR_ENV = 'CHATTYPOP_PROFILE_DIR';

/** Must run before app 'ready', when Electron fixes the session's storage paths. */
export function applyProfileDirOverride(): void {
  const dir = process.env[PROFILE_DIR_ENV];
  if (!dir) return;
  if (!isAbsolute(dir)) throw new Error(`${PROFILE_DIR_ENV} must be an absolute path, got "${dir}".`);
  mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}

/** A path in the app profile. Call lazily (never at module load): applyProfileDirOverride must run first. */
export const profilePath = (...parts: string[]): string => join(app.getPath('userData'), ...parts);

/**
 * Where the archive (database + media) lives. Kept in a tiny file beside the app profile because the
 * database can't hold its own location. The Discord login stays in the app profile.
 */
const STORAGE_CONFIG_FILE = 'storage.json';

export interface StorageConfig {
  archiveDir: string;
  /** Where the archive was moved from; its copy stays until the user deletes it. */
  previousDir?: string;
  /** Set by a move: the next start checks the copied database before trusting it. */
  verifyOnOpen?: boolean;
}

const configPath = (): string => profilePath(STORAGE_CONFIG_FILE);

export function storageConfig(): StorageConfig {
  try {
    if (existsSync(configPath())) {
      const cfg = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<StorageConfig>;
      if (typeof cfg.archiveDir === 'string' && cfg.archiveDir) {
        return {
          archiveDir: cfg.archiveDir,
          ...(typeof cfg.previousDir === 'string' && cfg.previousDir ? { previousDir: cfg.previousDir } : {}),
          ...(cfg.verifyOnOpen === true ? { verifyOnOpen: true } : {}),
        };
      }
    }
  } catch {
    // Unreadable config: fall back to the profile directory rather than failing to start.
  }
  return { archiveDir: profilePath() };
}

export const archiveDir = (): string => storageConfig().archiveDir;

export function saveStorageConfig(cfg: StorageConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
