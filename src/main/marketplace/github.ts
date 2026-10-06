// GitHub tokens reach api.github.com only on initial hops. Redirects omit tokens; anonymous public files bypass REST’s hourly quota.
import { COMMIT_PATTERN } from '@shared/installedPlugins';
import { MARKETPLACE_INDEX_FILE, parseMarketplaceIndex, type MarketplaceIndex } from '@shared/marketplace';
import { BYTES_PER_MB, MS_PER_MIN, MS_PER_S } from '@shared/units';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API_HOST = 'api.github.com';
const GITHUB_API = `https://${GITHUB_API_HOST}`;
/** Serves a public repo's files at a branch; its cache can lag a push by a few minutes. */
const RAW_FILES = 'https://raw.githubusercontent.com';
/** Serves a public repo's release assets by tag and name. */
const RELEASE_DOWNLOADS = 'https://github.com';
/** The REST API version these calls are written against. */
const API_VERSION = '2022-11-28';
/** API calls answer in about a second; this tolerates a slow link. */
export const API_TIMEOUT_MS = 20 * MS_PER_S;
/** A whole download, redirects included: a repo tarball on a slow link. */
export const DOWNLOAD_TIMEOUT_MS = 5 * MS_PER_MIN;
/** Asset and tarball downloads redirect once, to GitHub's download host; the rest is headroom, not a loop. */
export const MAX_REDIRECTS = 3;
/** An index or API answer; far above any real one. */
const MAX_JSON_BYTES = 5 * BYTES_PER_MB;
/** A release asset or source tarball, held in memory to hash. */
export const MAX_DOWNLOAD_BYTES = 200 * BYTES_PER_MB;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Encodes ref/tag path segments, rejecting dot segments that URL parsing resolves upward. */
function refPath(ref: string): string {
  const parts = ref.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`"${ref}" is not a usable branch or tag name`);
  return parts.map(encodeURIComponent).join('/');
}

async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const tooBig = (): never => {
    throw new Error(`${what} is larger than ${max / BYTES_PER_MB} MB`);
  };
  if (Number(res.headers.get('content-length') ?? 0) > max) tooBig();
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) tooBig();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Why GitHub refused, in words; never includes the token. */
function refusal(res: Response, what: string, hasToken: boolean): Error {
  const remaining = res.headers.get('x-ratelimit-remaining');
  if ((res.status === 403 || res.status === 429) && remaining === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const at = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * MS_PER_S).toLocaleTimeString()}` : '';
    return new Error(`${what}: GitHub's rate limit is used up${at}.${hasToken ? '' : ' A token raises it.'}`);
  }
  if (res.status === 404) return new Error(`${what}: not found, or ${hasToken ? 'the token' : 'GitHub without a token'} can't read it.`);
  if (res.status === 401) return new Error(`${what}: GitHub refused the token (expired or revoked). Replace it.`);
  if (res.status === 403) return new Error(`${what}: GitHub refused access (403). The token may lack read access to this repo.`);
  if (res.status === 429) return new Error(`${what}: GitHub is limiting requests (429). Try again later.`);
  return new Error(`${what}: GitHub answered ${res.status}.`);
}

/** A failed request's system code (ENOTFOUND, ECONNRESET…), which fetch puts on its cause. */
function networkCode(err: unknown): string {
  const { code, cause } = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } };
  const found = cause?.code ?? code;
  return typeof found === 'string' ? found : 'network error';
}

export class GitHub {
  /** Each repo's default branch, read once it answers. */
  private readonly defaultBranches = new Map<string, string>();

  constructor(private readonly fetchFn: FetchFn) {}

  /** GETs `url`, following redirects by hand; the token rides only the first hop, and only to api.github.com. */
  private async get(url: string, token: string | null, accept: string, timeoutMs: number, what: string): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const auth = hop === 0 && token !== null && current.host === GITHUB_API_HOST;
      const headers: Record<string, string> = { accept, 'user-agent': 'ChattyPop', 'x-github-api-version': API_VERSION };
      if (auth) headers['authorization'] = `Bearer ${token}`;
      let res: Response;
      try {
        res = await this.fetchFn(current.href, { method: 'GET', headers, redirect: 'manual', signal });
      } catch (err) {
        if (signal.aborted) throw new Error(`${what}: GitHub didn't answer within ${timeoutMs / MS_PER_S} s.`);
        // Only the code: a failed request's message can quote its headers, the token among them.
        throw new Error(`${what}: couldn't reach GitHub (${networkCode(err)}).`);
      }
      if (!REDIRECT_STATUSES.has(res.status)) {
        if (!res.ok) throw refusal(res, what, token !== null);
        return res;
      }
      const location = res.headers.get('location');
      if (!location) throw new Error(`${what}: GitHub redirected without a location.`);
      current = new URL(location, current);
      if (current.protocol !== 'https:') throw new Error(`${what}: GitHub redirected to a non-HTTPS address.`);
    }
    throw new Error(`${what}: more than ${MAX_REDIRECTS} redirects.`);
  }

  private async json(path: string, token: string | null, what: string): Promise<unknown> {
    const res = await this.get(`${GITHUB_API}${path}`, token, 'application/vnd.github+json', API_TIMEOUT_MS, what);
    return parseJson(await readCapped(res, MAX_JSON_BYTES, what), what);
  }

  private async defaultBranch(repo: string, token: string | null): Promise<string> {
    const known = this.defaultBranches.get(repo);
    if (known) return known;
    const meta = (await this.json(`/repos/${repo}`, token, repo)) as { default_branch?: unknown };
    if (typeof meta.default_branch !== 'string' || !meta.default_branch) throw new Error(`${repo}: GitHub's answer has no default branch.`);
    this.defaultBranches.set(repo, meta.default_branch);
    return meta.default_branch;
  }

  /** Reads default-branch marketplace.json. Anonymous reads use raw HEAD despite REST quota exhaustion; source fallbacks still need branch metadata. */
  async index(repo: string, token: string | null): Promise<MarketplaceIndex> {
    const what = `${repo} ${MARKETPLACE_INDEX_FILE}`;
    if (token !== null) {
      const branch = await this.defaultBranch(repo, token);
      const res = await this.get(`${GITHUB_API}/repos/${repo}/contents/${MARKETPLACE_INDEX_FILE}`, token, 'application/vnd.github.raw+json', API_TIMEOUT_MS, what);
      return parseMarketplaceIndex(parseJson(await readCapped(res, MAX_JSON_BYTES, what), what), branch);
    }
    const res = await this.get(`${RAW_FILES}/${repo}/HEAD/${MARKETPLACE_INDEX_FILE}`, null, 'application/octet-stream', API_TIMEOUT_MS, what);
    const index = parseJson(await readCapped(res, MAX_JSON_BYTES, what), what);
    return parseMarketplaceIndex(index, await this.defaultBranch(repo, null).catch(() => undefined));
  }

  /** Asset `name` of the release tagged `tag`: by its download URL without a token, through the API with one (a private repo's only way). */
  async releaseAsset(repo: string, tag: string, name: string, token: string | null): Promise<Buffer> {
    if (token !== null) return this.downloadAsset(repo, await this.releaseAssetId(repo, tag, name, token), token);
    const what = `${repo} release ${tag} ${name}`;
    const res = await this.get(`${RELEASE_DOWNLOADS}/${repo}/releases/download/${refPath(tag)}/${encodeURIComponent(name)}`, null, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS, what);
    return readCapped(res, MAX_DOWNLOAD_BYTES, what);
  }

  private async releaseAssetId(repo: string, tag: string, name: string, token: string): Promise<number> {
    const what = `${repo} release ${tag}`;
    const release = (await this.json(`/repos/${repo}/releases/tags/${refPath(tag)}`, token, what)) as { assets?: { id?: unknown; name?: unknown }[] };
    const asset = (Array.isArray(release.assets) ? release.assets : []).find((a) => a.name === name);
    if (!asset || !Number.isSafeInteger(asset.id)) throw new Error(`${what} has no asset ${name}.`);
    return asset.id as number;
  }

  private async downloadAsset(repo: string, assetId: number, token: string): Promise<Buffer> {
    const what = `${repo} asset ${assetId}`;
    const res = await this.get(`${GITHUB_API}/repos/${repo}/releases/assets/${assetId}`, token, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS, what);
    return readCapped(res, MAX_DOWNLOAD_BYTES, what);
  }

  /** The latest commit's sha on `branch`. */
  async latestCommit(repo: string, branch: string, token: string | null): Promise<string> {
    const what = `${repo} branch ${branch}`;
    const commit = (await this.json(`/repos/${repo}/commits/${refPath(branch)}`, token, what)) as { sha?: unknown };
    if (typeof commit.sha !== 'string' || !COMMIT_PATTERN.test(commit.sha)) throw new Error(`${what}: GitHub's answer has no commit sha.`);
    return commit.sha;
  }

  /** The repo's .tar.gz at `commit` (one top-level folder). */
  async downloadTarball(repo: string, commit: string, token: string | null): Promise<Buffer> {
    const what = `${repo} at ${commit.slice(0, 7)}`;
    if (!COMMIT_PATTERN.test(commit)) throw new Error(`${what}: not a commit sha.`);
    const res = await this.get(`${GITHUB_API}/repos/${repo}/tarball/${commit}`, token, 'application/vnd.github+json', DOWNLOAD_TIMEOUT_MS, what);
    return readCapped(res, MAX_DOWNLOAD_BYTES, what);
  }
}

function parseJson(body: Buffer, what: string): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`${what}: not valid JSON.`);
  }
}
