// External pages install transport plumbing instead of Electron preload. API calls queue until installation, regardless of host load order.
import { setMediaRoot } from '@shared/media';
import { SHELL_CAPABILITIES, SHELL_EMOJI_CACHE_ROOT, SHELL_EMOJI_SOURCE_ROOT, shellHas } from '@shared/shell';
import { installApi } from '@/api';
import { setPageOpener } from '@/ui/exportPage';
import { whenWritten } from '@/ui/idbStore';
import type { PhoneRendererApi } from './phoneApi';
export { pageEvents, pageFetch } from '@/pageTransport';

/** Installs the phone's API (createPhoneRendererApi) for host code, and where media URLs point. Once per page, before it renders. */
export function installRendererApi(api: PhoneRendererApi, mediaRoot: string): void {
  // A capability promises the native handler is ready. Older builds and transports with another media path keep HTTP.
  const nativeEmoji = mediaRoot === SHELL_EMOJI_SOURCE_ROOT && shellHas(SHELL_CAPABILITIES.emojiCache);
  setMediaRoot(mediaRoot, nativeEmoji ? { emoji: SHELL_EMOJI_CACHE_ROOT } : {});
  setPageOpener(api.openExport ?? null);
  installApi(api);
}

/** Reloads the page once what the stores are keeping (unsent messages, drafts) is written, so the reload finds it. */
export const reloadPage = (): Promise<void> => whenWritten().then(() => location.reload());
