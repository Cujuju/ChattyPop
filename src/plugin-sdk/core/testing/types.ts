// The core testing harness's public types (docs/plugin-architecture.md §15): SDK types only, so a plugin's tests never
// see a host internal (tests/pluginTesting.test.ts checks the import graph).
export type { CoreLink } from '@plugin-sdk/shared/testing';
import type { ActionResult, ActionRun, CorePlugin, DecisionProvider, LlmProvider, PluginDb } from '@plugin-sdk/core';
import type { CoreLink } from '@plugin-sdk/shared/testing';
import type {
  ChannelsOf,
  Client,
  EventsOf,
  JevFeatureRef,
  MembersFor,
  PluginDescriptor,
  PreferenceNames,
  PreferenceValue,
  RuleActionTypes,
  RuleConfig,
} from '@plugin-sdk/shared';

/** A rule's parts, as the Rules editor groups their kinds. */
export type RuleSection = 'triggers' | 'match' | 'filters' | 'actions';

/** Who a core call comes from, as its transport stamps it: a desktop window, the phone, or main. */
export type CallerAudience = 'renderer' | 'phone' | 'main';

/** Scripted provider declaration/registration for tests. */
export interface ScriptedProvider {
  /** A provider id (`<plugin id>` or `<plugin id>.<name>`); stored AI settings name it. */
  id: string;
  /** Runs on this PC: channels set to local AI only may use it. */
  local?: boolean;
  /** Declared to read images (ProviderDecl.images). */
  images?: boolean;
  /** Answers each completion; revoked, like any provider, when the plugin that holds it turns off. */
  provider: LlmProvider;
}

/** A server to seed; `hidden` marks it private (hidden with its channels while privacy mode is on). */
export interface SeedGuild {
  id: string;
  name?: string;
  hidden?: boolean;
}

/** A text channel to seed, archived unless `optIn: false`; a thread names its `parentId`. */
export interface SeedChannel {
  id: string;
  /** Its server; the first seeded (or the default) server otherwise. */
  guildId?: string;
  name?: string;
  parentId?: string;
  optIn?: boolean;
  /** Set to local AI only: hosted providers and Jev may not read it. */
  localOnly?: boolean;
  /** Marked private: hidden while privacy mode is on. */
  hidden?: boolean;
}

/** A message as plain fields; it arrives live through the gateway. */
export interface SeedMessage {
  channelId: string;
  content: string;
  /** A snowflake from `ts` when left out. */
  id?: string;
  /** When it was sent; the harness clock otherwise. */
  ts?: number;
  /** `u1` (Alice) when neither is given. */
  authorId?: string;
  /** Its display name. */
  authorName?: string;
  /** Any other Discord message fields (embeds, attachments, message_reference). */
  extra?: Record<string, unknown>;
}

/** The archive a test starts with. */
export interface SeedArchive {
  guilds?: readonly SeedGuild[];
  channels?: readonly SeedChannel[];
  /** History, synced before the plugin starts. */
  messages?: readonly SeedMessage[];
  /** Privacy mode: hidden servers and channels drop out of privacy-scoped reads. */
  privacyMode?: boolean;
}

/** The profile as an earlier version left it, for a plugin's adoption (`adopts`) to take over. */
export interface SeedProfile {
  /** Stored settings by their keys. */
  settings?: Readonly<Record<string, unknown>>;
  /** Statements run on the archive (legacy tables and their rows). */
  sql?: readonly string[];
}

/** How a test starts a plugin's core side. */
export interface TestOptions<D extends PluginDescriptor> {
  /** Written before adoption and the archive fixture. */
  profile?: SeedProfile;
  /** Other plugins installed with it, in build order after it: their core sides, or bare descriptors. */
  with?: readonly (CorePlugin | PluginDescriptor)[];
  /** Starts with the plugin turned off. */
  off?: boolean;
  archive?: SeedArchive;
  /** Its preferences as stored before it starts. */
  preferences?: { [N in PreferenceNames<D>]?: PreferenceValue<D, N> };
  ai?: {
    providers?: readonly ScriptedProvider[];
    /** Jev, asked only for switches that are on. */
    jev?: DecisionProvider;
    /** Settings → Jev switches: the plugin's own by local key, or the host's. */
    switches?: Partial<Record<JevFeatureRef<D>, boolean>>;
  };
  /**
   * The network behind ctx.net.fetch: each request hop that passed the descriptor's policy (declared hosts, owner-set
   * addresses, never Discord). Unset, requests reject.
   */
  network?: (url: URL, init: RequestInit) => Promise<Response>;
  /** The host's clock (rule runs, session times); Date.now otherwise. */
  clock?: () => number;
  /** The signed-in Discord user. */
  self?: string;
}

/** A plugin's core side running under the host, as a test drives it. */
export interface TestPlugin<D extends PluginDescriptor> {
  readonly plugin: D;
  /** Core calls as `audience`'s transport carries and stamps them: exactly the members that audience may call. */
  client<A extends CallerAudience>(audience: A): Client<MembersFor<ChannelsOf<D>, 'core', A>>;
  /** Payloads of event `name` the plugin emitted so far, oldest first. */
  events<K extends keyof EventsOf<ChannelsOf<D>> & string>(name: K): EventsOf<ChannelsOf<D>>[K][];
  /** Settings → Plugins' row for the plugin, or for another installed one by id: on, off, or failed with its error. */
  status(pluginId?: string): { status: 'active' | 'disabled' | 'error'; error: string | null };
  /** Turns the plugin off, as Settings → Plugins does; resolves once the host (and linked main sides) did. */
  off(): Promise<void>;
  on(): Promise<void>;
  /** ctx.mediaDir: the media store both of the plugin's sides keep files in. */
  readonly mediaDir: string;
  /** The archive database as the plugin's own reads see it (its tables, archive views); writes are the test's. */
  readonly db: PluginDb;
  archive: {
    /** Messages arriving live: archived and heard by plugins (ctx.archive.onText), then their channels' change noted (onChanged). */
    arrive(messages: readonly SeedMessage[]): string[];
    /** Changes a channel's local-AI-only or privacy mark. */
    setChannel(id: string, policy: Pick<SeedChannel, 'localOnly' | 'hidden'>): void;
    setPrivacyMode(on: boolean): void;
  };
  preferences: {
    get<N extends PreferenceNames<D>>(name: N): PreferenceValue<D, N>;
    /** Saved as a window saves it: every side hears the change. */
    set<N extends PreferenceNames<D>>(name: N, value: PreferenceValue<D, N>): void;
  };
  rules: {
    /** Runs a declared rule action as the rule engine does. */
    run<T extends RuleActionTypes<D>>(type: T, config: RuleConfig<D, 'actions', T>, run: ActionRun): ActionResult | Promise<ActionResult>;
    /** Why a rule kind can't run now, as the Rules editor explains it; null while its implementation is registered. */
    unavailable(section: RuleSection, type: string): string | null;
  };
  ai: {
    /** Why an AI provider can't run now, as Settings → AI says; null while one is registered for it. */
    unavailable(id: string): string | null;
  };
  /** Main reports the signed-in Discord user. */
  signIn(userId: string): void;
  /** The app restarts over the same profile: every activation ends, then a new core starts the installed plugins. */
  restart(): TestPlugin<D>;
  /** What a main side's or a window's harness reaches this core through. */
  readonly link: CoreLink;
  /** Turns every installed plugin off and closes the archive. */
  dispose(): Promise<void>;
}

/** Starts `definition` (its core side, or a descriptor with none) under the host. */
export type TestPluginFn = <D extends PluginDescriptor>(definition: CorePlugin<D> | D, options?: TestOptions<D>) => TestPlugin<D>;
