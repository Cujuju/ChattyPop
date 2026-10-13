import { MAIN_INVOKE } from '@shared/contract';
import type { MainCore } from '../coreClient';
import { StoreReplacements } from '../media/storeReplacements';
import { handleMain } from './mainCalls';

/** Local windows stream replacements through main; remote transports refuse these disk calls. */
export function registerAttachmentStoreHandlers(dir: string, core: Pick<MainCore, 'call'>): void {
  const store = new StoreReplacements(dir, core);
  handleMain(MAIN_INVOKE.media.beginReplacement, (id: unknown, ext: unknown) => store.begin(id, ext));
  handleMain(MAIN_INVOKE.media.replacementChunk, (token: unknown, offset: unknown, bytes: unknown) => store.chunk(token, offset, bytes));
  handleMain(MAIN_INVOKE.media.finishReplacement, (token: unknown) => store.finish(token));
  handleMain(MAIN_INVOKE.media.abortReplacement, (token: unknown) => store.abort(token));
}
