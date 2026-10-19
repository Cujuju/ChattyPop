import type { ArchiveMessage } from '@shared/contract';
import type { Db } from '../db';
import { archiveReadFence, readHost } from '../reads/archiveReads';
import { decorateMessagesAsync, type MessageSnapshot } from '../queries/messageDecorations';
import { activePluginCall } from './callContext';
import type { ArchiveReadOptions } from './pluginDb';
import type { ArchivePayload } from './archivePayloads';
import type { MessagePart } from '../messageParts';
import type { PartText } from '../derivedText';
import type { ArchiveToolScope } from '../ai/archiveTools';
import type { LinkPreview } from '../queries/linkPreviews';

type Options = Pick<ArchiveReadOptions, 'signal' | 'priority'>;
/** Host projections use the same cancellation, priority and committed snapshot contract as storage.read. */
export interface ArchiveAsyncReads {
  /** Bounded preview results; sharing-message enumeration, decompression and card choice run in the helper. */
  linkPreviews(ids: readonly number[], scope?: ArchiveToolScope, options?: Options): Promise<Map<number, LinkPreview>>;
  messages(ids: string[], options?: Options): Promise<ArchiveMessage[]>;
  /** Selected ids retain the caller's scope, including for compressed payloads. */
  payloads(ids: readonly string[], options?: Options): Promise<Map<string, ArchivePayload>>;
  /** Display parts and derived part text from the same committed snapshot; selected ids retain caller scope. */
  parts(ids: readonly string[], options?: Options): Promise<{ parts: Map<string, MessagePart[]>; texts: PartText[] }>;
}

export function archiveAsync(ready: () => Db, live: () => boolean): ArchiveAsyncReads {
  const context = (options: Options = {}) => {
    const call = activePluginCall();
    const signal = call ? options.signal ? AbortSignal.any([call.signal, options.signal]) : call.signal : options.signal;
    signal?.throwIfAborted();
    return { signal, priority: options.priority ?? call?.priority ?? 'background' };
  };
  return {
    linkPreviews: async (ids, scope, options) => {
      const { signal, priority } = context(options);
      if (!live() || !ids.length) return new Map();
      const entries = await readHost<[number, LinkPreview]>(ready(), { kind: 'linkPreviews', ids: [...ids], scope }, signal, priority);
      signal?.throwIfAborted();
      return live() ? new Map(entries) : new Map();
    },
    messages: async (ids, options) => {
      const { signal, priority } = context(options);
      if (!live() || !ids.length) return [];
      const fence = archiveReadFence(ready());
      const [snapshot] = await readHost<MessageSnapshot>(ready(), { kind: 'messages', ids }, signal, priority);
      signal?.throwIfAborted();
      return decorateMessagesAsync(snapshot!, () => { signal?.throwIfAborted(); fence(); return live(); });
    },
    payloads: async (ids, options) => {
      const { signal, priority } = context(options);
      if (!live() || !ids.length) return new Map();
      const entries = await readHost<[string, ArchivePayload]>(ready(), { kind: 'payloads', ids: [...ids] }, signal, priority);
      signal?.throwIfAborted();
      return live() ? new Map(entries) : new Map();
    },
    parts: async (ids, options) => {
      const { signal, priority } = context(options);
      if (!live() || !ids.length) return { parts: new Map(), texts: [] };
      const [snapshot] = await readHost<{ parts: [string, MessagePart[]][]; texts: PartText[] }>(ready(), { kind: 'parts', ids: [...ids] }, signal, priority);
      signal?.throwIfAborted();
      return live() ? { parts: new Map(snapshot!.parts), texts: snapshot!.texts } : { parts: new Map(), texts: [] };
    },
  };
}
