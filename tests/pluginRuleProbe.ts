// A bundled probe exercising all four rule sections through the public SDK.
import { ProviderRegistry } from '../src/core/ai/registry';
import { probe } from './pluginRuleDescriptor';
import { defineCorePlugin, type CoreContext, type ActionRun, type Settled, type RuleEdited } from '@plugin-sdk/core';
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { RuleInput, RuleSpec } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';
import { PluginHost } from '../src/core/plugins/host';
import { setSetting } from '../src/core/db';
import { ARRIVAL, type TextMessage } from '../src/core/arrival';
import { textMessage } from '../src/core/queries/messageText';
import type { Archive } from '../src/core/archive';
import type { Db } from '../src/core/db';
import type { RuleKinds } from '../src/core/rules/kinds';
import type { AppEvent } from '@shared/contract';
import { hostRuleStack } from './hostRules';
import { FakeJev } from './fakeJev';
import { tempDb, tempDir, seedArchive, rawMessage, nextTs, arrivedLive } from './helpers';
/** Installs the test descriptor in the same declaration list the build supplies; once, however often it is called. */
export function includeProbe(): () => void {
  const list = BUNDLED_PLUGINS as PluginDescriptor[];
  if (list.includes(probe)) return () => undefined;
  list.push(probe);
  return () => {
    list.splice(list.indexOf(probe), 1);
  };
}

/** A probe action by suffix, with stable per-rule ids. */
export const probeAction = (name = 'instant') => ({
  id: name,
  type: `ruleprobe.${name}`,
  config: null,
});

/** A message rule with optional replacement parts. */
export function probeInput(parts: Partial<RuleSpec> = {}): RuleInput {
  const input = newRuleInput();
  return {
    ...input,
    name: 'Probe rule',
    spec: {
      ...input.spec,
      actions: [probeAction()],
      ...parts,
    },
  };
}

/** What the probe's activation needs from the test: the stack's kinds, the archive and the clock it reads. */
export interface ProbeWiring {
  db: Db;
  kinds: RuleKinds;
  archive: () => Archive;
  jev: FakeJev;
  now: () => number;
  emit?: (e: AppEvent) => void;
}

/** Activates the probe through the real plugin host over `w`; fail (state) selects a callback that throws. */
export function activateProbe(w: ProbeWiring) {
  const runs: ActionRun[] = [];
  const settled: Settled[] = [];
  const edits: RuleEdited[] = [];
  const mayAct: boolean[] = [];
  const state = {
    fail: '',
    prepares: 0,
    coverage: null as number | null,
    nested: false,
  };
  let ctx!: CoreContext<typeof probe>;
  let trigger!: ReturnType<CoreContext<typeof probe>['rules']['trigger']>;
  const check = (name: string): void => {
    if (state.fail === name) throw new Error('hook failed');
  };
  const core = defineCorePlugin(probe, (context) => {
    ctx = context;
    trigger = ctx.rules.trigger('ruleprobe.start');
    ctx.rules.match('ruleprobe.direct', {
      prepare: (config) => {
        check('match.prepare');
        return config.toLowerCase();
      },
      direct: (config, {
        m
      }) => {
        check('direct');
        return m.content.includes(config) ? {
          kind: 'pattern',
          probability: null,
          highlight: null,
        } : null;
      },
    });
    ctx.rules.match('ruleprobe.question', {
      question: (config) => {
        check('question');
        return {
          subject: 'probe',
          features: ['ruleQuestions'],
          question: {
            type: 'noul',
            instructions: config,
          },
          match: (answer) => {
            check('answer');
            return answer.type === 'noul' ? answer.noul : null;
          },
        };
      },
    });
    ctx.rules.filter('ruleprobe.filter', {
      prepare: (config) => {
        state.prepares++;
        check('filter.prepare');
        return { min: config };
      },
      test: (config, {
        m
      }) => {
        check('test');
        return m.content.length >= config.min;
      },
    });
    ctx.rules.action('ruleprobe.instant', (_, run) => {
      check('action');
      runs.push(run);
      if (state.nested && run.event.kind === 'message') {
        trigger.fire({
          m: run.event.m,
          key: 'nested',
          liveAt: w.now(),
          accepts: () => true,
        });
      }
      return {
        outcome: 'done',
        detail: 'instant',
      };
    });
    ctx.rules.action('ruleprobe.after', async (_, run) => {
      check('after');
      runs.push(run);
      await Promise.resolve();
      if (state.nested && run.event.kind === 'message') {
        trigger.fire({
          m: run.event.m,
          key: 'async-nested',
          liveAt: w.now(),
          accepts: () => true,
        });
      }
      return {
        outcome: 'done',
        detail: 'after',
      };
    });
    ctx.rules.action('ruleprobe.window', (_, run) => {
      runs.push(run);
      return {
        outcome: 'done',
        detail: 'window',
      };
    });
    ctx.rules.onSettled((event) => {
      check('settled');
      settled.push(event);
    });
    ctx.rules.onEdited((event) => {
      check('edited');
      edits.push(event);
    });
    ctx.rules.windows.coveredUntil(() => {
      check('coverage');
      return state.coverage;
    });
    ctx.jev.questions.register({
      subject: 'probe-extra',
      feature: 'ruleQuestions',
      question: (_, c) => {
        mayAct.push(c.mayAct('ruleprobe.instant'));
        return null;
      },
    });
  });
  const host = new PluginHost(tempDir(), {
    db: w.db,
    emit: w.emit ?? (() => undefined),
    changed: () => undefined,
    ai: async () => ({
      text: '',
    }),
    decider: () => null,
    bundled: {
      rules: w.kinds,
      ready: () => w.db,
      archive: w.archive,
      mediaDir: tempDir(),
      attachmentsDir: tempDir(),
      pluginData: {
        root: tempDir(),
        unmoved: {},
      },
      storeText: () => undefined,
      catchUp: () => undefined,
      storeLinkText: () => undefined, storeLinkImages: () => undefined,
      saveSetting: (key, value) => setSetting(w.db, key, value),
      aiSettings: () => {
        throw new Error('No AI settings in this probe.');
      },
      providers: new ProviderRegistry(() => undefined),
      decider: w.jev.forFeature,
      now: w.now,
    },
  }, [core]);
  host.startBundled();
  return {
    host,
    state,
    runs,
    settled,
    edits,
    mayAct,
    context: () => ctx,
    fire: (m: TextMessage, key: string, accepts = true) => trigger.fire({
      m,
      key,
      liveAt: w.now(),
      accepts: () => accepts,
    }),
  };
}

/** Starts the real host and engine over a fresh archive, with the probe active; fail selects a callback that throws. */
export function startProbe() {
  const db = tempDb();
  let now = Date.now();
  const jev = new FakeJev();
  jev.on.ruleQuestions = true;
  jev.values.probe = 1;
  const stack = hostRuleStack(db, () => undefined, jev.forFeature, undefined, () => now);
  const archive = seedArchive(db, [{
    id: 'c1',
  }]);
  const probeSide = activateProbe({ db, kinds: stack.engine.kinds, archive: () => archive, jev, now: () => now });
  let messageAt = now;
  const message = (content = 'hit'): TextMessage => {
    messageAt = Math.max(nextTs(), now, messageAt + 1);
    const raw = rawMessage('c1', messageAt, content);
    archive.ingestMessages([raw], ARRIVAL.gateway);
    return textMessage(db, raw.id)!;
  };
  return {
    ...stack,
    ...probeSide,
    db,
    jev,
    message,
    advance: (ms: number) => {
      now += ms;
    },
    check: (m: TextMessage) => stack.matcher.check(m, arrivedLive()),
  };
}
