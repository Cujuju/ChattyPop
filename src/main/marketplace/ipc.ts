// RendererApi.marketplace over IPC. Arguments come from a window, so each is type-checked before use.
import { ipcMain } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { BUILT_IN_MARKETPLACES, type InstallChoice } from '@shared/marketplace';
import { errorMessage } from '@shared/errors';
import { diag } from '../diagnostics';
import { SECRET_FILES } from '../secretFile';
import { profilePath } from '../storageLocation';
import { Marketplaces, type BuildPlugin } from './marketplaces';

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
  ipcMain.handle(ch.state, () => m.state());
  ipcMain.handle(ch.add, (_e, repo: unknown, token: unknown) => m.add(str(repo, 'repo'), strOrNull(token, 'token')));
  ipcMain.handle(ch.remove, (_e, repo: unknown) => m.remove(str(repo, 'repo')));
  ipcMain.handle(ch.setToken, (_e, repo: unknown, token: unknown) => m.setToken(str(repo, 'repo'), strOrNull(token, 'token')));
  ipcMain.handle(ch.refresh, () => m.refresh());
  ipcMain.handle(ch.install, (_e, repo: unknown, id: unknown, choice: unknown) => m.install(str(repo, 'repo'), str(id, 'pluginId'), choiceOf(choice)));
  ipcMain.handle(ch.installLocal, (_e, path: unknown) => m.installLocal(str(path, 'path')));
  ipcMain.handle(ch.uninstall, (_e, id: unknown) => m.uninstall(str(id, 'pluginId')));
  ipcMain.handle(ch.cancel, (_e, id: unknown) => m.cancel(str(id, 'pluginId')));
}
