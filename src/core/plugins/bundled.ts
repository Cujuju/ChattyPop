// Bundled plugins' core side (docs/plugin-architecture.md): what the core provides to build each plugin's context
// (./context), and the types its extension points share with the host.
import type { AppEvent, PluginDataDirs } from '@shared/contract';
import type { AiSettings, JevFeature } from '@shared/settings';
import type { DecisionProvider } from '../ai/decisions';
import type { ProviderRegistry } from '../ai/registry';
import type { Archive } from '../archive';
import type { Db } from '../db';
import type { LinkImage } from '../messageImages';
import { countAttemptsSince, lastDone, recordOutcome } from '../rules/ruleStore';
import type { RuleKinds } from '../rules/kinds';
import type { ActionResult } from '../rules/actions';
import type { NetworkSend } from './net';

export type { ActionResult };

/** Whether archived text arrived directly or through transcription. */
export type TextSource = 'message' | 'transcript';

/** Text a plugin made for a message (a transcript), read as part of the message's text after its content. */
export interface DerivedText {
  /** Unique within the plugin (an attachment id); settling the same key again replaces its text. */
  key: string;
  /** Its place among the message's derived texts; positive (the content comes first). */
  order: number;
  text: string;
  /** When its source reached ChattyPop (audio queued): its arrival time for rules. */
  queuedAt: number;
  /** The message part it is the text of (messageParts partKey), so another plugin (translation) can read it per part. */
  part?: string;
  /**
   * Whether Jev is asked about the message again for it (default true). False: rules' direct matches and the answers the
   * text settles (a cashtag's Trading) apply; Jev's earlier answers stand.
   */
  askJev?: boolean;
}

/** What the core provides to build each plugin's context. */
export interface BundledDeps {
  /** The same registry the rule engine uses. */
  rules: RuleKinds;
  /** The archive database, or the reason it isn't open (startup failed, the archive is moving). */
  ready(): Db;
  archive(): Archive;
  mediaDir: string;
  attachmentsDir: string;
  /** Where plugins' data folders are. */
  pluginData: PluginDataDirs;
  /** Stores a plugin's derived text (with `record`, in one transaction) and dispatches its message as an edit (derivedText.settle). */
  storeText(pluginId: string, messageId: string, t: DerivedText, record?: () => void): void;
  /** Stores a plugin's text for a link (with `record`, in one transaction) and judges again the messages it gave text (linkText.set). */
  storeLinkText(pluginId: string, url: string, text: string, record?: () => void): void;
  /** Stores a plugin's images for a link (with `record`, in one transaction) and reports the messages sharing it (linkImages.set). */
  storeLinkImages(pluginId: string, url: string, images: readonly LinkImage[], record?: () => void): void;
  /** The core's setSetting: stores, tells every window, and runs what depends on the key. */
  saveSetting(key: string, value: unknown): void;
  /** Settings → AI as requests use them now (a default that can't run gives way). */
  aiSettings(): AiSettings;
  /** The AI registry plugins register providers in and request them from. */
  providers: AiProviders;
  /** Jev for one Settings → Jev switch, or null while it (or Jev) is off; read per call, so a toggle applies at once. */
  decider(feature: JevFeature): DecisionProvider | null;
  /** Requests one Jev catch-up over the lookback window, coalesced until the current synchronous work finishes. */
  catchUp(): void;
  now(): number;
  /** The network ctx.net.fetch sends through once its policy allows a request; the global fetch when unset. */
  send?: NetworkSend;
  lastSeenAt?(): number;
  readerNames?(): string[] | null;
}

/** The registry members plugin contexts use, and the plugin host's state binding. */
export type AiProviders = Pick<ProviderRegistry, 'get' | 'register' | 'providers' | 'unavailable' | 'isLocal' | 'openRouterKeys' | 'bindPlugins'>;

/** A plugin's view of its rule actions' runs. */
export interface RuleRuns {
  /** When this rule's action last ran to completion, or null. */
  lastDone(ruleId: number, actionId: string): number | null;
  /** Actions of `type` attempted (done or failed) since `sinceTs`, across every rule. */
  attemptsSince(type: string, sinceTs: number): number;
  /** Rewrites an action's recorded outcome after its run recorded one (a late report); no-op once the rule is deleted. */
  update(runId: number, actionId: string, type: string, r: ActionResult): void;
}

/** Rule runs over the core's rule store. */
export function pluginRuleRuns(db: Db, emit: (e: AppEvent) => void, now: () => number): RuleRuns {
  return {
    lastDone: (ruleId, actionId) => lastDone(db, ruleId, actionId),
    attemptsSince: (type, sinceTs) => countAttemptsSince(db, type, sinceTs),
    update: (runId, actionId, type, r) => {
      try {
        recordOutcome(db, runId, actionId, type, r.outcome, r.detail, now());
      } catch {
        return; // the rule was deleted meanwhile (its runs went with it)
      }
      emit({ type: 'rules-changed' });
    },
  };
}

/** What the plugin host knows across plugins, for one plugin's context. */
export interface HostPlugins {
  /** The signed-in user, once main reported it. */
  self(): string | null;
  /** Any active plugin's derived text for the message is still coming. */
  textPending(messageId: string): boolean;
  /** Runs every active plugin's text.onSettled. */
  textSettled(messageId: string): void;
  /** This activation continues the previous session's without a gap (CoreContext.session.resumed); default false. */
  resumed?: boolean;
}
