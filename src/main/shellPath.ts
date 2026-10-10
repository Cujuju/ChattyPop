// A packaged app started from the Finder or a desktop launcher gets the system's bare PATH, not the owner's shell's, so
// the tools the app runs (tailscale, claude, codex, npm) are not found. Windows gives every app the full PATH.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { app } from 'electron';
import { errorMessage } from '@shared/errors';
import { MS_PER_S } from '@shared/units';
import { diag } from './diagnostics';
import { IS_WINDOWS } from './platform';

/** Brackets the PATH in the shell's output: its startup files may print lines of their own. */
const MARK = '__CHATTYPOP_PATH__';
/** A login shell answers in a fraction of a second; a slow or stuck one must not hold the start. */
const SHELL_TIMEOUT_MS = 3 * MS_PER_S;
/** Used when the account names no shell. */
const DEFAULT_SHELL = '/bin/sh';

/** Where tools are commonly installed, for when the shell can't be asked: Homebrew, /usr/local, and per-user installs. */
export const commonToolDirs = (home: string): string[] => ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')];

/** The PATH between the marks in a login shell's output; null when it printed none. */
export function pathFromShellOutput(output: string): string | null {
  const parts = output.split(MARK);
  const path = parts.length >= 3 ? parts[1]!.trim() : '';
  return path || null;
}

/** The shell's folders first (the owner's order decides which copy of a tool runs), then the rest of `current`, then `fallback`. */
export function mergedPath(current: string, shell: string | null, fallback: readonly string[]): string {
  const dirs = [...(shell ?? '').split(delimiter), ...current.split(delimiter), ...fallback].filter((d) => d && isAbsolute(d));
  return [...new Set(dirs)].join(delimiter);
}

/** The PATH the owner's login shell has (interactive, so it reads the same startup files a terminal does); null when it can't say. */
function loginShellPath(): string | null {
  const shell = process.env['SHELL'] || DEFAULT_SHELL;
  try {
    // printenv, not $PATH: every shell runs it the same way (fish holds PATH as a list).
    const output = execFileSync(shell, ['-ilc', `echo ${MARK}; printenv PATH; echo ${MARK}`], {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return pathFromShellOutput(output);
  } catch (err) {
    diag('shell-path-failed', { shell, message: errorMessage(err) });
    return null;
  }
}

/** Gives this process, and core (which inherits its environment), the owner's shell PATH. Call before core starts. */
export function applyShellPath(): void {
  // A dev run starts from a shell and already has it.
  if (IS_WINDOWS || !app.isPackaged) return;
  const fallback = commonToolDirs(homedir()).filter((d) => existsSync(d));
  process.env['PATH'] = mergedPath(process.env['PATH'] ?? '', loginShellPath(), fallback);
}
