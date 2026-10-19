import type { ArchiveMessage } from '@shared/contract';
import type { Db } from '../db';
import { readHost } from '../reads/archiveReads';
import { decorateMessages, type MessageSnapshot } from '../queries/messageDecorations';
import { activePluginCall } from './callContext';
import type { ArchiveReadOptions } from './pluginDb';
import type { ArchivePayload } from './archivePayloads';
import type { MessagePart } from '../messageParts';
import type { PartText } from '../derivedText';

type Options = Pick<ArchiveReadOptions, 'signal' | 'priority'>;
/** Host projections use the same cancellation, priority and committed snapshot contract as storage.read. */
export interface ArchiveAsyncReads {
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
    messages: async (ids, options) => {
      const { signal, priority } = context(options);
      if (!live() || !ids.length) return [];
      const [snapshot] = await readHost<MessageSnapshot>(ready(), { kind: 'messages', ids }, signal, priority);
      signal?.throwIfAborted();
      return live() ? decorateMessages(snapshot!) : [];
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
