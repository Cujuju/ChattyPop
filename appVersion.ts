// Git history determines the version. Feature commits increment minor and reset patch; other commits increment patch.
import { execFileSync } from 'node:child_process';

/** Pre-1.0: breaking changes bump minor, like any feature. */
const MAJOR = 0;
/** Conventional-commit feature subject, scoped or not; `feat!:` counts. Plugin releases bump by it too. */
export const FEATURE_SUBJECT = /^feat(\([^)]*\))?!?:/;

/** Private-history root. Histories containing it count from zero. */
export const ARCHIVE_ROOT = '12801786904a67d7157fea14883a11adffb1b3d4';

export interface VersionBase {
  features: number;
  patches: number;
}

/** Archived version added to exported-history counts; null until the export sets it. */
export const ARCHIVE_VERSION: VersionBase | null = { features: 371, patches: 3 };

export interface LogEntry {
  hash: string;
  parents: string[];
  subject: string;
}

/** Git’s %x00 log separator; hashes and subjects contain no NUL. */
const FIELD = '\0';

function git(repoDir: string, args: string[]): string {
  // Output grows with history; no cap.
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity }).trim();
}

/** Excludes merges. Archive history supplies the base version; subsequent features increment minor, and commits since the latest feature increment patch. */
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
