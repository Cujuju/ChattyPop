// Checks declared AI read channels against the selected provider and effective local-AI-only policy at dispatch.
import type { ReadScope } from '@shared/plugins';
import type { AiSettings, ProviderId } from '@shared/settings';
import type { Db } from '../db';
import { hostedMayReadSql, localOnlyChannelIds } from '../channelPolicy';
import type { DecisionProvider, DecisionRequest, DecisionResult, Question } from './decisions';
import type { ProviderRegistry } from './registry';
import { ProviderUnavailableError, TURNED_OFF, chosenModel, type CompletionRequest, type CompletionResult, type LlmProvider } from './types';

export type { ReadScope };
/** A request's declared read scope. */
export interface Reads {
  reads: ReadScope;
}
/** Who a selection of sources is for: any hosted model (Jev included), or provider `provider`. */
export type AiReader = 'hosted' | { provider: ProviderId };

/** A hosted provider or Jev was asked to read a channel set to local AI only (or a thread under one). */
export class LocalOnlyError extends Error {
  override readonly name = 'LocalOnlyError';
}

/** Who a request goes to: whether it runs on this PC, and its name in a refusal. */
interface Recipient {
  local: boolean;
  label: string;
}

/** Jev always runs on OpenRouter or TypeSafe. */
const JEV: Recipient = { local: false, label: 'Jev' };

/** `reads` as a request gave it; throws TypeError when it is missing or malformed (a folder plugin is plain JavaScript). */
function declared(reads: unknown): ReadScope {
  if (reads === 'all' || (Array.isArray(reads) && reads.every((id) => typeof id === 'string'))) return reads as ReadScope;
  throw new TypeError("An AI request must declare what it reads: `reads`, channel ids or 'all'.");
}

/** Throws LocalOnlyError for hosted reads of local-only channels, including inherited policies and all-channel reads. Missing reads throws TypeError. */
export function assertMayRead(db: Db, given: unknown, to: Recipient): void {
  const reads = declared(given);
  if (to.local) return;
  const localOnly = localOnlyChannelIds(db);
  if (reads === 'all') {
    if (localOnly.size) throw new LocalOnlyError(`Some channels are set to local AI only, so ${to.label} (hosted) may not read every channel.`);
    return;
  }
  const refused = [...new Set(reads)].filter((id) => localOnly.has(id));
  if (refused.length === 1) throw new LocalOnlyError(`This channel is set to local AI only, so ${to.label} (hosted) may not read it.`);
  if (refused.length) throw new LocalOnlyError(`${refused.length} of these channels are set to local AI only, so ${to.label} (hosted) may not read them.`);
}

/** Checks Jev requests: Jev is hosted. */
export const assertJevMayRead = (db: Db, reads: unknown): void => assertMayRead(db, reads, JEV);

/** The registry members that say who a provider is. */
type ProviderFacts = Pick<ProviderRegistry, 'isLocal' | 'providers'>;

const recipient = (registry: ProviderFacts, id: ProviderId): Recipient => ({
  local: registry.isLocal(id),
  label: registry.providers().find((p) => p.id === id)?.label ?? id,
});

/** Checks a request to provider `id`. */
export const assertProviderMayRead = (db: Db, registry: ProviderFacts, id: ProviderId, reads: unknown): void =>
  assertMayRead(db, reads, recipient(registry, id));

/** Picks sources a reader may be sent (ctx.ai.sources). */
export interface AiSources {
  /** The channels among `ids` that `reader` may read, in order: every one for a local provider. */
  permitted(ids: readonly string[], reader: AiReader): string[];
  /** SQL condition: the channel id in `column` may be read by `reader` (always true for a local provider). */
  sql(column: string, reader: AiReader): string;
}

/** Source selection over the archive's current channel policy. */
export function aiSources(db: () => Db, isLocal: (id: ProviderId) => boolean): AiSources {
  const local = (reader: AiReader): boolean => reader !== 'hosted' && isLocal(reader.provider);
  return {
    permitted: (ids, reader) => {
      if (local(reader)) return [...ids];
      const localOnly = localOnlyChannelIds(db());
      return ids.filter((id) => !localOnly.has(id));
    },
    sql: (column, reader) => (local(reader) ? '1' : hostedMayReadSql(column)),
  };
}

/** A completion request a plugin makes: its declared reads, checked at dispatch. */
export type PluginCompletionRequest = CompletionRequest & Reads;

/** A provider as plugins get it: every completion declares what it reads. */
export interface PluginProvider extends Omit<LlmProvider, 'complete' | 'dispose'> {
  complete(req: PluginCompletionRequest): Promise<CompletionResult>;
}

/** `provider`, checking each completion's reads with `check` before it is sent. */
export function scopedProvider(provider: LlmProvider, check: (reads: unknown) => void): PluginProvider {
  const { planUsage } = provider;
  return {
    id: provider.id,
    maxInputChars: provider.maxInputChars,
    complete: async ({ reads, ...req }) => {
      check(reads);
      return provider.complete(req);
    },
    listModels: () => provider.listModels(),
    ...(planUsage ? { planUsage: () => planUsage.call(provider) } : {}),
  };
}

/** Jev as plugins get it: every request declares what it reads. */
export interface PluginDecider {
  readonly model: string;
  readonly maxInputChars: number;
  decide<Q extends Record<string, Question>>(req: DecisionRequest<Q> & Reads): Promise<DecisionResult<Q>>;
}

/** Checks Jev read scope when queued and before sending, so queued requests respect policy changes. */
export function scopedDecider(jev: DecisionProvider, db: () => Db): PluginDecider {
  return {
    model: jev.model,
    maxInputChars: jev.maxInputChars,
    decide: async ({ reads, ...req }) => {
      const admit = (): void => {
        assertJevMayRead(db(), reads);
        req.admit?.();
      };
      admit();
      return jev.decide({ ...req, admit });
    },
  };
}

/** `jev` with every request declaring `reads`: for work whose requests all read the same channels (a summary run). */
export function boundDecider(jev: PluginDecider, reads: ReadScope): DecisionProvider {
  return {
    model: jev.model,
    maxInputChars: jev.maxInputChars,
    decide: (req) => jev.decide({ ...req, reads }),
  };
}

/** A completion from the provider a folder plugin names (HostDeps.ai). */
export type ScopedCompletion = (req: Omit<CompletionRequest, 'model' | 'effort'> & Reads & { provider: ProviderId }) => Promise<{ text: string; json?: unknown }>;

/** Validates provider availability, settings and read scope before sending a folder plugin completion with the selected model and effort. */
export function scopedCompletion(db: () => Db, registry: ProviderFacts & Pick<ProviderRegistry, 'get' | 'unavailable'>, settings: () => AiSettings): ScopedCompletion {
  return async ({ reads, provider, ...req }) => {
    declared(reads);
    const s = settings();
    const choice = s.providers[provider];
    const why = registry.unavailable(provider) ?? (choice?.enabled ? null : TURNED_OFF);
    if (why) throw new ProviderUnavailableError(why);
    assertProviderMayRead(db(), registry, provider, reads);
    const r = await registry.get(provider, s).complete({ ...req, ...chosenModel(choice!) });
    return { text: r.text, json: r.json };
  };
}
