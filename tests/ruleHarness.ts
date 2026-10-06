// Rule engine over a seeded archive, wired as core wires it, for host rule tests. Its plugin kinds are the rule probe's
// (pluginRuleProbe.ts), active through the real plugin host.
import type { AppEvent } from '@shared/contract';
import type { PluginRange } from '@shared/plugins';
import type { RawMessage } from '@shared/discord';
import type { RuleGates, RuleInput } from '@shared/rules';
import type { RangeDeps } from '../src/core/rules/rangeActions';
import { ARRIVAL, type Arrival } from '../src/core/arrival';
import type { LegacyRuleMatch as RuleMatch, LegacyRuleNarrow as RuleNarrow } from './ruleFixtures';
import { activateProbe, includeProbe, probeAction } from './pluginRuleProbe';
import { hostRuleStack, ruleInput } from './hostRules';
import { FakeJev } from './fakeJev';
import { from, nextTs, rawMessage, seedArchive, tempDb } from './helpers';

export { hostRuleStack, ruleInput, runsOf } from './hostRules';
export { probeAction } from './pluginRuleProbe';

// Registers the rule-probe plugin.
includeProbe();

/** The host's command action's requests, answered with `answer` (a test may swap it). */
export interface FakeRanges extends RangeDeps {
  commands: { pluginId: string; commandId: string; range: PluginRange }[];
  answer: () => Promise<string | null>;
}

export function fakeRanges(): FakeRanges {
  const f: FakeRanges = {
    commands: [],
    answer: async () => 'answered',
    runPluginCommand: async (pluginId, commandId, range) => {
      f.commands.push({ pluginId, commandId, range });
      return f.answer();
    },
  };
  return f;
}

/** `now`: the clock the engine and the probe read (a test steps it past intervals). */
export function ruleHarness(now: () => number = Date.now) {
  const db = tempDb();
  const events: AppEvent[] = [];
  const emit = (e: AppEvent): void => void events.push(e);
  const jev = new FakeJev();
  const ranges = fakeRanges();
  const stack = hostRuleStack(db, emit, jev.forFeature, ranges, now);
  const { matcher } = stack;
  const archive = seedArchive(db, [{ id: 'c1' }, { id: 'c2', guildId: 'g2' }], {
    guilds: [
      { id: 'g1', name: 'G1' },
      { id: 'g2', name: 'G2' },
    ],
    // As core wires it: every message text through the matcher.
    onText: (m, arrived) => matcher.check(m, arrived),
    onLinkedText: (m, arrived) => matcher.check(m, arrived),
  });
  /** The rule probe plugin: its action runs, settlements and switch (probe.host.setEnabled). */
  const probe = activateProbe({ db, kinds: stack.engine.kinds, archive: () => archive, jev, now, emit });
  /** A message from `author` in `channel`, arriving `via` (live gateway by default); returns it. */
  const say = (content: string, o: { author?: string; channel?: string; via?: Arrival; extra?: Partial<RawMessage> } = {}): RawMessage => {
    const m = rawMessage(o.channel ?? 'c1', nextTs(), content, { ...from(o.author ?? 'u2'), ...o.extra });
    if ((o.via ?? ARRIVAL.gateway) === ARRIVAL.sync) archive.ingestSyncPage(m.channel_id, [m], 'newer', false);
    else archive.ingestMessages([m], o.via ?? ARRIVAL.gateway);
    return m;
  };
  return { ...stack, db, events, archive, jev, ranges, probe, say };
}

export type Harness = ReturnType<typeof ruleHarness>;

/** A rule whose probe action records every match, taking missed messages too: the host's stand-in for a watch rule. */
export const probeRule = (
  match: RuleMatch,
  o: { narrow?: RuleNarrow; gates?: Partial<RuleGates>; name?: string } = {},
): RuleInput =>
  ruleInput([probeAction()], { match, narrow: o.narrow, gates: { missed: true, ...o.gates }, name: o.name ?? 'T' });
