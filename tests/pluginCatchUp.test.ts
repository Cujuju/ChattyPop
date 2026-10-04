// Catch-up after a plugin turns back on: work that arrived while it was off is judged once its registrations are back.
import { expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { ProviderRegistry } from '../src/core/ai/registry';
import { Archive } from '../src/core/archive';
import { ARRIVAL } from '../src/core/arrival';
import { setSetting, type Db } from '../src/core/db';
import type { BundledDeps } from '../src/core/plugins/bundled';
import { RuleKinds } from '../src/core/rules/kinds';
import { PluginHost } from '../src/core/plugins/host';
import { FakeJev } from './fakeJev';
import { nextTs, rawMessage, seedArchive, settleAsync, tempDb, tempDir } from './helpers';
import { hostRuleStack } from './hostRules';

/** The judging plugin's per-message Jev question. */
const JUDGE_SUBJECT = 'judge';
/** Jev's answer to it: a sure yes. */
const SURE = 0.99;
const judge = definePlugin({ manifest: { id: 'judge', name: 'Judge', version: '1', description: '' } });

/** The real host with a plugin judging every message through Jev (as auto tags do), wired to the rule matcher as core init wires it. */
function judgeHost() {
  const db = tempDb();
  const jev = new FakeJev();
  jev.on.ruleQuestions = true;
  const stack = hostRuleStack(db, () => undefined, jev.forFeature);
  let catchUps = 0;
  const judged: string[] = [];
  const archive = seedArchive(db, [{ id: 'c1' }], { onText: (m, a) => stack.matcher.check(m, a) });
  const core = defineCorePlugin(judge, (ctx) => {
    ctx.jev.questions.register({
      subject: JUDGE_SUBJECT,
      feature: 'ruleQuestions',
      question: () => ({ type: 'noul', instructions: 'Does `message` mention a stock?' }),
      onAnswer: (m, a) => void (a.type === 'noul' && a.noul >= SURE && judged.push(m.id)),
    });
  });
  const host = new PluginHost(tempDir(), {
    db,
    emit: () => undefined,
    changed: () => undefined,
    ai: async () => ({ text: '' }),
    decider: () => null,
    bundled: {
      rules: stack.engine.kinds,
      ready: () => db,
      archive: () => archive,
      mediaDir: tempDir(),
      attachmentsDir: tempDir(),
      pluginData: { root: tempDir(), unmoved: {} },
      storeText: () => undefined,
      storeLinkText: () => undefined, storeLinkImages: () => undefined,
      saveSetting: (key, value) => setSetting(db, key, value),
      aiSettings: () => {
        throw new Error('No AI settings in this test.');
      },
      providers: new ProviderRegistry(() => undefined),
      decider: jev.forFeature,
      catchUp: () => {
        catchUps++;
        stack.matcher.requestCatchUp();
      },
      now: Date.now,
    },
  }, [core], [judge]);
  host.startBundled();
  onTestFinished(() => host.setEnabled('judge', false)); // its registrations are process-wide
  return { jev, host, archive, judged, catchUps: () => catchUps };
}

it('judges messages that arrived while the plugin was off once it is turned back on', async () => {
  const h = judgeHost();
  h.jev.values[JUDGE_SUBJECT] = SURE;
  await h.host.setEnabled('judge', false);
  const m = rawMessage('c1', nextTs(), 'NVDA to the moon');
  h.archive.ingestMessages([m], ARRIVAL.gateway);
  await settleAsync();
  expect(h.jev.requests).toEqual([]);
  const before = h.catchUps();
  await h.host.setEnabled('judge', true);
  await settleAsync();
  expect(h.catchUps() - before).toBe(1);
  expect(h.judged).toEqual([m.id]);
});

const probe = definePlugin({ manifest: { id: 'resumeprobe', name: 'Resume probe', version: '1', description: '' } });

/** One core session over `db`: a fresh host whose build includes the probe when `included`. */
function session(db: Db, seen: boolean[], included = true) {
  const deps: BundledDeps = {
    rules: new RuleKinds(),
    ready: () => db,
    archive: () => new Archive(db),
    mediaDir: tempDir(),
    attachmentsDir: tempDir(),
    pluginData: { root: tempDir(), unmoved: {} },
    storeText: () => undefined,
    storeLinkText: () => undefined, storeLinkImages: () => undefined,
    saveSetting: (key, value) => setSetting(db, key, value),
    aiSettings: () => {
      throw new Error('No AI settings in this test.');
    },
    providers: new ProviderRegistry(() => undefined),
    decider: () => null,
    catchUp: () => undefined,
    now: Date.now,
  };
  const core = defineCorePlugin(probe, (ctx) => void seen.push(ctx.session.resumed));
  const host = new PluginHost(tempDir(), { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null, bundled: deps }, included ? [core] : [], included ? [probe] : []);
  host.startBundled();
  return host;
}

it('tells an activation whether it continues the previous one without a gap', async () => {
  const db = tempDb();
  const seen: boolean[] = [];
  session(db, seen); // first run
  const second = session(db, seen); // on through the last session's end
  await second.setEnabled('resumeprobe', false);
  await second.setEnabled('resumeprobe', true); // off meanwhile
  session(db, seen); // on again by that session's end
  await session(db, seen).setEnabled('resumeprobe', false);
  const offAtStart = session(db, seen); // off at start: no activation
  await offAtStart.setEnabled('resumeprobe', true);
  session(db, seen, false); // a build without it
  session(db, seen);
  expect(seen).toEqual([false, true, false, true, true, false, false]);
});
