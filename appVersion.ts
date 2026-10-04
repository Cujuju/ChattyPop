// ChattyPop's one version, derived from git history so every build of a commit agrees:
// a `feat` commit bumps the minor number and resets the patch; any other commit bumps the patch.
import { execFileSync } from 'node:child_process';

/** Pre-1.0: breaking changes bump minor, like any feature. */
const MAJOR = 0;
/** Conventional-commit feature subject, scoped or not; `feat!:` counts. Plugin releases bump by it too. */
export const FEATURE_SUBJECT = /^feat(\([^)]*\))?!?:/;

/** Root commit of the private history this repo was exported from. A history holding it counts from zero. */
export const ARCHIVE_ROOT = '12801786904a67d7157fea14883a11adffb1b3d4';

export interface VersionBase {
  features: number;
  patches: number;
}

/** The archive's last version, added to an exported history's count. Set by the export's last private commit; null until then. */
export const ARCHIVE_VERSION: VersionBase | null = { features: 371, patches: 3 };

export interface LogEntry {
  hash: string;
  parents: string[];
  subject: string;
}

/** Log field separator, written by git for `%x00` (argv can't hold NUL); no hash or subject contains it. */
const FIELD = '\0';

function git(repoDir: string, args: string[]): string {
  // Output grows with history; no cap.
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity }).trim();
}

/**
 * `0.<feat commits>.<non-feat commits not reachable from any feat>`, merges excluded, over `log` (all of HEAD's commits).
 * Outside the archive, `base` continues it: features add to its minor; with none, commits add to its patch.
 */
export function versionFromLog(log: LogEntry[], base: VersionBase | null): string {
  const isMerge = (c: LogEntry): boolean => c.parents.length > 1;
  const features = log.filter((c) => !isMerge(c) && FEATURE_SUBJECT.test(c.subject));
  const parentsOf = new Map(log.map((c) => [c.hash, c.parents]));
  const covered = new Set<string>();
  const pending = features.map((c) => c.hash);
  for (let hash = pending.pop(); hash !== undefined; hash = pending.pop()) {
    if (covered.has(hash)) continue;
    covered.add(hash);
    pending.push(...(parentsOf.get(hash) ?? []));
  }
  const patches = log.filter((c) => !isMerge(c) && !covered.has(c.hash)).length;
  const from = log.some((c) => c.hash === ARCHIVE_ROOT) ? null : base;
  if (!from) return `${MAJOR}.${features.length}.${patches}`;
  if (features.length > 0) return `${MAJOR}.${from.features + features.length}.${patches}`;
  return `${MAJOR}.${from.features}.${from.patches + patches}`;
}

/** `versionFromLog` of HEAD's history, continuing `base` outside the archive. A shallow clone undercounts. */
export function appVersion(repoDir: string, base: VersionBase | null = ARCHIVE_VERSION): string {
  let out: string;
  try {
    out = git(repoDir, ['log', '--format=%H%x00%P%x00%s', 'HEAD']);
  } catch (err) {
    throw new Error(`ChattyPop's version comes from git history; build from a git checkout with at least one commit. ${String(err)}`);
  }
  const log = out.split('\n').map((line): LogEntry => {
    const [hash = '', parents = '', subject = ''] = line.split(FIELD);
    return { hash, parents: parents ? parents.split(' ') : [], subject };
  });
  return versionFromLog(log, base);
}
