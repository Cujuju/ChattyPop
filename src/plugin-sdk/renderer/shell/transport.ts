// External pages install transport plumbing instead of Electron preload. API calls queue until installation, regardless of host load order.
import { setMediaRoot } from '@shared/media';
import { SHELL_CAPABILITIES, SHELL_EMOJI_CACHE_ROOT, SHELL_EMOJI_SOURCE_ROOT, shellHas } from '@shared/shell';
import { installApi } from '@/api';
import { setPageOpener } from '@/ui/exportPage';
import { whenWritten } from '@/ui/idbStore';
import type { PhoneRendererApi } from './phoneApi';

/** Installs the phone's API (createPhoneRendererApi) for host code, and where media URLs point. Once per page, before it renders. */
export function installRendererApi(api: PhoneRendererApi, mediaRoot: string): void {
  // A capability promises the native handler is ready. Older builds and transports with another media path keep HTTP.
  const nativeEmoji = mediaRoot === SHELL_EMOJI_SOURCE_ROOT && shellHas(SHELL_CAPABILITIES.emojiCache);
  setMediaRoot(mediaRoot, nativeEmoji ? { emoji: SHELL_EMOJI_CACHE_ROOT } : {});
  setPageOpener(api.openExport ?? null);
  installApi(api);
}

/** A path on this page's own origin; anything absolute is refused, so a page reaches only the server that served it. */
function samePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`Not a path on this page's origin: ${path}`);
  return path;
}

/** Fetch to the server that served this page. */
export const pageFetch = (path: string, init?: RequestInit): Promise<Response> => fetch(samePath(path), init);

/** An event stream from the server that served this page. */
export const pageEvents = (path: string): EventSource => new EventSource(samePath(path));

/** Reloads the page once what the stores are keeping (unsent messages, drafts) is written, so the reload finds it. */
export const reloadPage = (): Promise<void> => whenWritten().then(() => location.reload());
