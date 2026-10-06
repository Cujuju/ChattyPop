// Provider contracts: a completion provider (LlmProvider) and what a plugin registers to supply one (ProviderImpl).
import type { ModelOption, PlanUsageWindow, ProviderStatus, TokenUsage } from '@shared/contract';
import type { ProviderDecl } from '@shared/descriptorParts';
import type { ProviderId, ProviderSettings } from '@shared/settings';
export type { ModelOption, PlanUsageWindow, ProviderId, TokenUsage };

/** An image sent with a prompt, as base64 (RFC 4648) of the file's bytes. */
export interface CompletionImage {
  /** image/png, image/jpeg… */
  mediaType: string;
  data: string;
}

export interface CompletionRequest {
  /** Replaces the provider's own system prompt entirely. */
  system: string;
  prompt: string;
  /** Read with the prompt; only a provider declared with `images` takes them (others refuse the request). */
  images?: readonly CompletionImage[];
  /** The longest answer wanted, in tokens; a provider that can't limit it answers in full. */
  maxOutputTokens?: number;
  /** JSON Schema the answer must satisfy; the result then carries `json`. */
  schema?: Record<string, unknown>;
  model?: string;
  /** Thinking/effort level, one of the model's ModelOption.efforts; absent = the provider's own default. */
  effort?: string;
  signal?: AbortSignal;
}

/** A provider's chosen model and effort as request fields; null settings (provider default) are left out. */
export const chosenModel = (p: { model: string | null; effort: string | null }): Pick<CompletionRequest, 'model' | 'effort'> => ({
  ...(p.model ? { model: p.model } : {}),
  ...(p.effort ? { effort: p.effort } : {}),
});

export interface CompletionResult {
  text: string;
  json?: unknown;
  /** As reported by the provider for this call; absent when it reports none. */
  usage?: TokenUsage;
  /** USD cost or estimate at API list rates; absent for unknown or local costs. */
  apiCostUsd?: number;
}

export interface LlmProvider {
  readonly id: ProviderId;
  /** Largest prompt, in characters, a completion sends in one call (chunking boundary). */
  readonly maxInputChars: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Subscription usage windows; null when the account has none (API key, local). */
  planUsage?(): Promise<PlanUsageWindow[] | null>;
  /** Models the user can pick from. */
  listModels(): Promise<ModelOption[]>;
  dispose?(): void;
}

export class ProviderUnavailableError extends Error {}

/** The owner's Settings → AI choice for one provider; null fields are the provider's own default. */
export type ProviderChoice = Pick<ProviderSettings, 'model' | 'effort'>;

/** A provider's Settings → AI state: whether it can run, why in one line, and its models (null: not listed). */
export type ProviderReport = Omit<ProviderStatus, 'id'>;

/** What a plugin registers for a declared provider (ctx.ai.registerProvider). */
export interface ProviderImpl {
  /** The provider for this choice; called per request, so it may hand back one kept instance. */
  create(choice: ProviderChoice): LlmProvider;
  /** Its Settings → AI state; `refresh` re-lists what it keeps for the session (model lists). */
  status(choice: ProviderChoice, refresh: boolean): Promise<ProviderReport>;
}

/** A provider whose plugin runs but whose Use switch in Settings → AI is off. */
export const TURNED_OFF = 'Turned off in Settings → AI.';

/** A declared provider and why it can't run now (its plugin is off or absent); null while it can. */
export interface ProviderInfo extends ProviderDecl {
  unavailable: string | null;
}

/** Completion output token cap. */
export const HOSTED_MAX_INPUT_CHARS = 100_000;
