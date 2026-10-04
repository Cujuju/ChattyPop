// A plugin's channel contract (docs/plugin-architecture.md §5): the calls each side serves and the events core emits,
// each member with the audiences that may reach it. Arguments, results and payloads cross processes: structured-cloneable,
// and WireValues (wire.ts) for members the phone reaches.

import { unwrapPluginCall, type PluginCallResult } from './pluginCall';
import type { IsWire } from './wire';

/** Who a call or event is for; stamped by the transport a call arrives on, never claimed by the caller. */
export type Audience = 'renderer' | 'phone' | 'main';
/** Main's calls are for windows only (the phone reaches core alone). */
export type MainAudience = 'renderer';
/** The audiences each section's members may name, as checkBundled holds descriptors to them. */
export const SECTION_AUDIENCES: { readonly core: readonly Audience[]; readonly main: readonly MainAudience[]; readonly events: readonly Audience[] } = {
  core: ['renderer', 'phone', 'main'],
  main: ['renderer'],
  events: ['renderer', 'phone', 'main'],
};

/** The shapes a contract types: core's and main's calls (name → function), and core's events (name → payload). */
export interface ChannelShapes {
  core?: object;
  main?: object;
  events?: object;
}

/**
 * A core call main reports finished work through (§3 completion reports): main-only, with the most issued keys the
 * host's ledger keeps (the oldest past it is forgotten, and its report refused).
 */
export interface CompletionMember {
  readonly audiences: readonly ['main'];
  readonly completion: { readonly max: number };
}

/** Checks and shapes a call's arguments as it arrives, before the handler runs; throws the reason they are refused. */
export type Decoder<Args extends readonly unknown[] = readonly unknown[]> = (args: readonly unknown[]) => Args;

/**
 * A core call declared with options: `writes`, whether it changes anything (stated for every call the phone may make);
 * `decode`, its arguments' check on every transport, required when the phone may make a call that writes.
 */
export interface CallMember<Args extends readonly unknown[] = readonly unknown[]> {
  readonly audiences: readonly Audience[];
  readonly writes?: boolean;
  readonly decode?: Decoder<Args>;
  /** Not a completion report (CompletionMember). */
  readonly completion?: never;
}

type AudienceOf<Section> = Section extends 'main' ? MainAudience : Audience;
type ArgsOf<F> = F extends (...args: infer A) => unknown ? A : never;
type ResultOf<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;
type MemberSpec<Section, F> = Section extends 'core' ? readonly Audience[] | CompletionMember | CallMember<ArgsOf<F>> : readonly AudienceOf<Section>[];
/** Every member of each section a contract types, with its audiences (a core member may be a completion report or a CallMember). */
export type ChannelSpec<S extends ChannelShapes> = { [Section in keyof S]-?: { [K in keyof S[Section]]-?: MemberSpec<Section, S[Section][K]> } };

/** The type error a phone member's shape gets when some part of it isn't a WireValue. */
interface NotWire {
  readonly 'what the phone sends or receives must be a WireValue': true;
}
/** What a member the phone reaches must also satisfy: WireValue shapes; a core call states `writes`, and one that writes has `decode`. */
type PhoneRules<Section, F, M> = Section extends 'events'
  ? IsWire<F> extends true ? unknown : NotWire
  : Section extends 'core'
    ? (IsWire<ArgsOf<F>> extends true ? (IsWire<ResultOf<F>> extends true ? unknown : NotWire) : NotWire) &
      (M extends { readonly writes: true } ? { readonly decode: Decoder<ArgsOf<F>> } : M extends { readonly writes: false } ? unknown : { readonly writes: boolean })
    : unknown;
type ShapeIn<S, Section, K> = Section extends keyof S ? (K extends keyof S[Section] ? S[Section][K] : never) : never;
/** `A`'s phone members held to PhoneRules; every other member as declared. */
export type PhoneChecked<S extends ChannelShapes, A> = {
  [Section in keyof A]: { [K in keyof A[Section]]: 'phone' extends AudiencesIn<A[Section][K]> ? PhoneRules<Section, ShapeIn<S, Section, K>, A[Section][K]> : unknown };
};

/** Any declared contract, as the host reads it at run time. */
export interface AnyChannels {
  readonly audiences: { readonly [section: string]: { readonly [member: string]: readonly Audience[] | CompletionMember | CallMember } };
}

/** A declared contract: the audiences at run time, the shapes as types only. */
export interface Channels<S extends ChannelShapes = ChannelShapes, A extends ChannelSpec<S> = ChannelSpec<S>> extends AnyChannels {
  readonly audiences: A;
  /** Types only; never set. */
  readonly shapes?: S;
}

/**
 * Declares a contract: `defineChannels<Shapes>()({ core: { status: { audiences: ['renderer', 'phone'], writes: false } }, … })`.
 * Members the phone reaches are held to PhoneChecked by type (and checkBundled at run time).
 */
export const defineChannels =
  <S extends ChannelShapes>() =>
  <const A extends ChannelSpec<S>>(audiences: A & PhoneChecked<S, A>): Channels<S, A> => ({ audiences });

type ShapeOf<C, Section extends keyof ChannelShapes> = C extends Channels<infer S, infer _A> ? (S[Section] extends object ? S[Section] : object) : object;
type SpecOf<C, Section extends keyof ChannelShapes> = C extends Channels<infer _S, infer A> ? (Section extends keyof A ? A[Section] : object) : object;

/** A member's audiences, from its spec. */
type AudiencesIn<M> = M extends readonly (infer X)[] ? X : M extends { readonly audiences: readonly (infer X)[] } ? X : never;

/** Members of a section whose audiences include one of `Aud`. */
export type MembersFor<C, Section extends keyof ChannelShapes, Aud extends Audience> = {
  [K in keyof ShapeOf<C, Section> as K extends keyof SpecOf<C, Section> ? (Aud & AudiencesIn<SpecOf<C, Section>[K]> extends never ? never : K) : never]: ShapeOf<C, Section>[K];
};

/** Core members declared as completion reports. */
type CompletionKeys<C> = { [K in keyof SpecOf<C, 'core'>]: SpecOf<C, 'core'>[K] extends CompletionMember ? K : never }[keyof SpecOf<C, 'core'>];
/** Completion report members (name → function); a plugin handles them with ctx.completions, not serve. */
export type CompletionsOf<C> = { [K in keyof ShapeOf<C, 'core'> as K extends CompletionKeys<C> ? K : never]: ShapeOf<C, 'core'>[K] };

type Fn = (...args: never[]) => unknown;
/** The caller's view of calls: each resolves with the result. */
export type Client<T> = { [K in keyof T]: T[K] extends Fn ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> : never };
/** What a side serves: every member of its section as declared, except core's completion reports. */
export type Served<C, Section extends 'core' | 'main'> = {
  [K in keyof ShapeOf<C, Section> as Section extends 'core' ? (K extends CompletionKeys<C> ? never : K) : K]: ShapeOf<C, Section>[K] extends Fn
    ? (...args: Parameters<ShapeOf<C, Section>[K]>) => ReturnType<ShapeOf<C, Section>[K]> | Promise<Awaited<ReturnType<ShapeOf<C, Section>[K]>>>
    : never;
};
/** Events of a contract (name → payload). */
export type EventsOf<C> = ShapeOf<C, 'events'>;

/** A typed client over an untyped transport. */
export const clientOver = <T>(send: (name: string, args: unknown[]) => Promise<PluginCallResult>): T =>
  new Proxy({} as object, {
    // Not 'then': a client must never pass for a promise when returned from an async function.
    get: (_target, name) => (typeof name === 'string' && name !== 'then' ? (...args: unknown[]) => send(name, args).then(unwrapPluginCall) : undefined),
  }) as T;

const memberOf = (c: AnyChannels | undefined, section: keyof ChannelShapes, name: string): readonly Audience[] | CompletionMember | CallMember | undefined =>
  Object.hasOwn(c?.audiences[section] ?? {}, name) ? c!.audiences[section]![name] : undefined;

/** A member's audiences, or none when the contract doesn't declare it. */
export const audiencesOf = (c: AnyChannels | undefined, section: keyof ChannelShapes, name: string): readonly Audience[] => {
  const m = memberOf(c, section, name);
  return m === undefined ? [] : 'audiences' in m ? m.audiences : m;
};

/** A core member's completion declaration, or null when it is an ordinary call (or undeclared). */
export const completionOf = (c: AnyChannels | undefined, name: string): CompletionMember['completion'] | null => {
  const m = memberOf(c, 'core', name);
  return m !== undefined && 'completion' in m ? (m.completion ?? null) : null;
};

/** A core call's argument decoder, or null when it declares none. */
export const decoderOf = (c: AnyChannels | undefined, name: string): Decoder | null => {
  const m = memberOf(c, 'core', name);
  return m !== undefined && 'decode' in m && m.decode ? m.decode : null;
};

/** Member names of a section. */
export const membersOf = (c: AnyChannels | undefined, section: keyof ChannelShapes): string[] => Object.keys(c?.audiences[section] ?? {});

/** The function a side serves for member `name`, or null (Served is checked by type; this reads it at run time). */
export function servedMember(impl: object, name: string): ((...args: unknown[]) => unknown) | null {
  const fn: unknown = Reflect.get(impl, name);
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}
