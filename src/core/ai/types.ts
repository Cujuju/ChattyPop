// Provider contracts: a completion provider (LlmProvider) and what a plugin registers to supply one (ProviderImpl).
import type { ModelOption, PlanUsageWindow, ProviderStatus, TokenUsage } from '@shared/contract';
import type { ProviderDecl } from '@shared/descriptorParts';
import type { AiSettings, ProviderId, ProviderSettings } from '@shared/settings';
import { accountKey, type ProviderAuth } from '@shared/providerAccounts';
export type { ModelOption, PlanUsageWindow, ProviderId, TokenUsage };

/** An image sent with a prompt, as base64 (RFC 4648) of the file's bytes. */
export interface CompletionImage {
  /** image/png, image/jpeg… */
  mediaType: string;
  data: string;
}

/** An earlier turn of the conversation a completion continues. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** A function the model may call while it answers; it runs in the caller's process. */
export interface CompletionTool {
  /** Unique in the request; matches TOOL_NAME_PATTERN. */
  name: string;
  description: string;
  /** JSON Schema of the arguments: `type: 'object'` with `properties`. */
  parameters: Record<string, unknown>;
  /** The text the model reads back. A throw reaches the model as the call's failure. */
  run(args: unknown, signal: AbortSignal): Promise<string>;
}

/** What a running completion reports, in order. */
export type CompletionEvent =
  /** More of the answer; the deltas join to the result's `text`. */
  | { type: 'text'; delta: string }
  /** The model called a tool; `toolResult` with the same `callId` follows. */
  | { type: 'toolCall'; callId: string; name: string; args: unknown }
  | { type: 'toolResult'; callId: string; ok: boolean };

export interface CompletionRequest {
  /** Replaces the provider's own system prompt entirely. */
  system: string;
  /** The new user turn. */
  prompt: string;
  /** Earlier turns, oldest first; `prompt` follows them. */
  history?: readonly ChatTurn[];
  /** Only a provider declared with `tools` takes them (others refuse the request); never with `schema`. */
  tools?: readonly CompletionTool[];
  /** Required with `tools`: the most tool calls run; later calls are answered TOOL_CALLS_SPENT, so the model answers. */
  maxToolCalls?: number;
  /** Progress while it runs. Not called after the request settles or its signal aborts. */
  onEvent?(event: CompletionEvent): void;
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
export type ProviderReport = Omit<ProviderStatus, 'id' | 'apiKeyHint' | 'auth'>;

/** Where a provider sends its requests instead of its vendor: the owner's proxy (Settings → AI → Proxy). */
export interface ProviderProxy {
  /** http(s) base address without a trailing slash. */
  url: string;
  /** The proxy's client key; null when the owner stored none. A secret: never in a command line or a window. */
  key: string | null;
}

/** The account a provider runs under; secrets are read per request. */
export interface ProviderAccount {
  id: ProviderId;
  auth: ProviderAuth;
  apiKey(): string | null;
  dir: string | null;
  /** The proxy its requests go through now; null: straight to its vendor. Absent on hosts without proxies. */
  proxy?(): ProviderProxy | null;
}

/** A provider-driven sign-in, cancelled by its owner or plugin lifetime. */
export interface AccountLinkIo {
  /** Publishes a sign-in URL; alreadyOpened prevents reopening a CLI's browser. */
  open(url: string, alreadyOpened?: boolean): void;
  code(): Promise<string>;
  signal: AbortSignal;
}

/** What a plugin registers for a declared provider (ctx.ai.registerProvider). */
export interface ProviderImpl {
  /** The provider for this choice; called per request, so it may hand back one kept instance. */
  create(choice: ProviderChoice, account: ProviderAccount): LlmProvider;
  /** Its Settings → AI state; `refresh` re-lists what it keeps for the session (model lists). */
  status(choice: ProviderChoice, refresh: boolean, account: ProviderAccount): Promise<ProviderReport>;
  /** Rejects a key its vendor doesn't accept before storage. Required when the declaration has `apiKey`. */
  checkApiKey?(key: string): Promise<void>;
  linkAccount?(account: ProviderAccount, io: AccountLinkIo): Promise<void>;
  removeAccount?(account: ProviderAccount): Promise<void>;
  /** Stops retained providers when the registration ends, preserving their sign-ins. */
  dispose?(): void;
}

/** A provider whose plugin runs, listed in Settings → AI, whose Use switch there is off. */
export const TURNED_OFF = 'Turned off in Settings → AI providers.';
/** A declared provider whose plugin runs but which the owner has not added, or removed. */
export const NOT_ADDED = 'Not added in Settings → AI providers.';
/** Why a provider that can run takes no requests; null while it is on. */
export function offReason(id: ProviderId, settings: AiSettings): string | null {
  const p = settings.providers[id];
  if (p?.enabled) return null;
  return accountKey(id) || p?.added ? TURNED_OFF : NOT_ADDED;
}

/** A declared provider and why it can't run now (its plugin is off or absent); null while it can. */
export interface ProviderInfo extends ProviderDecl {
  unavailable: string | null;
}

/** Completion output token cap. */
export const HOSTED_MAX_INPUT_CHARS = 100_000;
