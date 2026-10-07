// RendererApi.marketplace over IPC. Arguments come from a window, so each is type-checked before use.
import { MAIN_INVOKE } from '@shared/contract';
import { BUILT_IN_MARKETPLACES, type InstallChoice } from '@shared/marketplace';
import { errorMessage } from '@shared/errors';
import { diag } from '../diagnostics';
import { SECRET_FILES } from '../secretFile';
import { profilePath } from '../storageLocation';
import { Marketplaces, type BuildPlugin } from './marketplaces';
import { handleMain } from '../ipc/mainCalls';

export interface MarketplaceHandlerDeps {
  /** The source build; omitted until it is wired, and source installs are refused meanwhile. */
  build?: BuildPlugin;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new TypeError(`${what} must be a non-empty string`);
  return v;
};
const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what));
function choiceOf(v: unknown): InstallChoice {
  const c = v as Partial<Record<string, unknown>> | null;
  if (c?.['kind'] === 'source') return { kind: 'source' };
  if (c?.['kind'] === 'release') return { kind: 'release', version: str(c['version'], 'choice.version') };
  throw new TypeError('choice must be { kind: "release", version } or { kind: "source" }');
}

export function registerMarketplaceHandlers({ build }: MarketplaceHandlerDeps): void {
  const { marketplace: ch } = MAIN_INVOKE;
  const m = new Marketplaces({ profileDir: profilePath(), secrets: SECRET_FILES, fetch, build: build ?? null, builtIn: BUILT_IN_MARKETPLACES,
    leftoverFailed: (path, err) => diag('marketplace-leftover', { path, message: errorMessage(err) }) });
  handleMain(ch.state, () => m.state());
  handleMain(ch.add, (repo: unknown, token: unknown) => m.add(str(repo, 'repo'), strOrNull(token, 'token')));
  handleMain(ch.remove, (repo: unknown) => m.remove(str(repo, 'repo')));
  handleMain(ch.setToken, (repo: unknown, token: unknown) => m.setToken(str(repo, 'repo'), strOrNull(token, 'token')));
  handleMain(ch.refresh, () => m.refresh());
  handleMain(ch.install, (repo: unknown, id: unknown, choice: unknown) => m.install(str(repo, 'repo'), str(id, 'pluginId'), choiceOf(choice)));
  handleMain(ch.installLocal, (path: unknown) => m.installLocal(str(path, 'path')));
  handleMain(ch.uninstall, (id: unknown) => m.uninstall(str(id, 'pluginId')));
  handleMain(ch.cancel, (id: unknown) => m.cancel(str(id, 'pluginId')));
}
