// A bundled plugin's Jev services (docs/plugin-architecture.md §3–§4, §8): deciders and judgments bound to its
// activation's lifetime, and its per-message questions. Registrations are dropped when the plugin turns off.
import { jevFeatureOn } from '@shared/aiSettings';
import { pluginJevFeature, type JevFeatureRef, type PluginDescriptor } from '@shared/bundledTypes';
import { boundDecider, scopedDecider, type PluginDecider } from '../ai/readScope';
import { revocableDecider } from '../ai/revocable';
import type { MessageQuestion } from '../jev/messageQuestions';
import { MessageJudge, type Answers, type JudgeOptions } from '../jev/messageJudge';
import type { Question } from '../ai/decisions';
import type { TextMessage } from '../arrival';
import type { Registrations } from './api';
import type { BundledDeps } from './bundled';
import type { Lifetime } from './lifetime';
import { pluginQuestion } from './questions';

/**
 * Host context, cache and cost handling for owner-triggered ranges; `fresh` drops answers to questions changed meanwhile.
 * `judgeNow` reads the message's channel and asks nothing of a local-AI-only one.
 */
export interface RangeJudgments {
  /** Drops stored answers for `subject`, whose question changed. */
  forget(subject: string): void;
  /** Judges `m` now, however old; resolves with the fresh answers by subject and the request's cost. */
  judgeNow(decider: PluginDecider, m: TextMessage, questions: Record<string, Question>, opts?: JudgeOptions): Promise<{ answers: Answers; costUsd: number | null }>;
}

/** Jev services scoped to one bundled plugin. */
export interface PluginJev<D extends PluginDescriptor = PluginDescriptor> {
  /**
   * Jev for a Settings → Jev switch (one it declares, or the host's), or null while that switch (or Jev) is off. Read per
   * call. Requests declare `reads`; Jev is hosted, so a local-AI-only channel throws LocalOnlyError.
   */
  decider(feature: JevFeatureRef<D>): PluginDecider | null;
  /** Whether the owner turned on a switch (one it declares, or the host's); read per call. */
  isOn(feature: JevFeatureRef<D>): boolean;
  /** A per-message Jev question (Settings → Jev), asked in the same request as the host's, turned on by its switch(es). */
  questions: { register(q: PluginMessageQuestion<JevFeatureRef<D>>, order?: 'plugin' | 'owner'): () => void };
  /** Rechecks missing judgments in the host lookback window. */
  catchUp(): void;
  judgments: RangeJudgments;
}

/** A plugin's per-message question: `feature` names switches it declares, or the host's. */
export type PluginMessageQuestion<F extends string> = Omit<MessageQuestion, 'feature'> & { feature: F | readonly F[] };

/** Builds a plugin's Jev services over its activation's `lifetime`; `ask` runs plugin code with a fallback. */
export function pluginJev<D extends PluginDescriptor>(
  plugin: D,
  buildIndex: number,
  bundled: BundledDeps,
  reg: Registrations,
  lifetime: Lifetime,
  live: () => boolean,
  ask: <T>(fn: () => T, fallback: T) => T,
): PluginJev<D> {
  const id = plugin.manifest.id;
  const stamped = (feature: string) => pluginJevFeature(plugin, feature);
  return {
    catchUp: () => { if (live()) bundled.catchUp(); },
    isOn: (feature) => jevFeatureOn(bundled.aiSettings().jev, stamped(feature)),
    judgments: {
      forget: (subject) => { if (live()) new MessageJudge(bundled.ready()).forget(subject); },
      judgeNow: (decider, message, questions, opts) =>
        lifetime.fence(new MessageJudge(bundled.ready()).judgeNow(revocableDecider(boundDecider(decider, [message.channelId]), lifetime.signal), message, questions, opts)),
    },
    decider: (feature) => {
      const jev = bundled.decider(stamped(feature));
      return jev && scopedDecider(revocableDecider(jev, lifetime.signal), () => bundled.ready());
    },
    questions: {
      register: (q, order = 'plugin') => {
        const feature = typeof q.feature === 'string' ? stamped(q.feature) : q.feature.map(stamped);
        return pluginQuestion({ ...q, feature }, { plugin: id, buildIndex, forOwner: order === 'owner' }, reg, ask);
      },
    },
  };
}
