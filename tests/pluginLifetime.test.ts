// An activation's lifetime: providers and Jev it was handed are cancelled when its plugin turns off, and late answers are dropped.
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type LlmProvider } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { PluginInactiveError } from '@shared/pluginCall';
import type { DecisionProvider, DecisionRequest, DecisionResult, Question } from '../src/core/ai/decisions';
import { JevProvider, type JevRoute } from '../src/core/ai/jev';
import { revocable } from '../src/core/ai/revocable';
import type { CompletionRequest, CompletionResult } from '../src/core/ai/types';

/** Claude as a provider, answering through `complete`. */
const claude = (complete: LlmProvider['complete'], maxInputChars = 100_000) => ({
  providers: [{ id: 'claude', provider: { id: 'claude', maxInputChars, complete, listModels: async () => [] } }],
});

/** Creates an externally resolved request. */
interface Held<T> {
  signal: AbortSignal | undefined;
  answer(value: T): void;
}

/** The fake Jev's request budget. */
const HELD_JEV_MAX_INPUT_CHARS = 64_000;

/** Jev whose every request waits until the test answers it. */
function heldJev(): DecisionProvider & { held: Held<Record<string, unknown>>[] } {
  const held: Held<Record<string, unknown>>[] = [];
  return {
    model: 'held-jev',
    maxInputChars: HELD_JEV_MAX_INPUT_CHARS,
    held,
    decide: <Q extends Record<string, Question>>(req: DecisionRequest<Q>) =>
      new Promise<DecisionResult<Q>>((resolve) => held.push({ signal: req.signal, answer: (answers) => resolve({ answers: answers as DecisionResult<Q>['answers'], costUsd: null }) })),
  };
}

/** The channel every fixture request reads. */
const READS = ['c1'];
/** What a batch of Jev requests came to: how many were asked, and what the answered ones cost. */
interface Batch {
  asked: number;
  costUsd: number;
}
/** Fixture plugin issues sequential AI calls, concurrent Jev requests, and one retained Jev answer per activation. */
const probe = definePlugin({
  manifest: { id: 'lifetimeprobe', name: 'Lifetime probe', version: '1', description: '' },
  channels: defineChannels<{ core: { run(steps: number): string; judgeMany(count: number): Batch } }>()({ core: { run: ['renderer'], judgeMany: ['renderer'] } }),
  jev: { features: [{ key: 'judging', default: false }] },
});
const core = defineCorePlugin(probe, (ctx) => {
  const kept = ctx.storage.table('answers');
  ctx.storage.migrate([`CREATE TABLE ${kept} (noul REAL)`]);
  ctx.channels.serve({
    run: async (steps) => {
      let text = '';
      for (let i = 0; i < steps; i++) text = (await ctx.ai.provider('claude').complete({ system: '', prompt: `step ${i}`, reads: READS })).text;
      return text;
    },
    judgeMany: async (count) => {
      const jev = ctx.jev.decider('judging');
      if (!jev) return { asked: 0, costUsd: 0 };
      const ask = (i: number) => jev.decide({ state: {}, questions: { [`q${i}`]: { type: 'noul', instructions: 'Trading?' } }, reads: READS });
      const settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => ask(i)));
      const costUsd = settled.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value.costUsd ?? 0 : 0), 0);
      return { asked: count, costUsd };
    },
  });
  const jev = ctx.jev.decider('judging');
  void jev
    ?.decide({ state: {}, questions: { worth: { type: 'noul', instructions: 'Worth reading?' } }, reads: READS })
    .then(({ answers }) => {
      const a = answers.worth;
      if (a?.type === 'noul') ctx.storage.db.prepare(`INSERT INTO ${kept} (noul) VALUES (?)`).run(a.noul);
    })
    .catch(() => undefined);
});

describe('a revoked provider', () => {
  it('settles a running call at once, even when the provider ignores its signal', async () => {
    const revoke = new AbortController();
    const stalled = revocable({ id: 'claude', maxInputChars: 1, complete: () => new Promise<never>(() => undefined), listModels: async () => [] }, revoke.signal);
    const call = stalled.complete({ system: '', prompt: '' });
    revoke.abort(new PluginInactiveError('claude'));
    await expect(call).rejects.toBeInstanceOf(PluginInactiveError);
  });

  it('settles a running call at once when its own signal (a deadline) aborts, even when the provider ignores it', async () => {
    const stalled = revocable({ id: 'claude', maxInputChars: 1, complete: () => new Promise<never>(() => undefined), listModels: async () => [] }, new AbortController().signal);
    const deadline = new AbortController();
    const call = stalled.complete({ system: '', prompt: '', signal: deadline.signal });
    deadline.abort(new DOMException('late', 'TimeoutError'));
    await expect(call).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('a plugin turned off mid-run', () => {
  /** More model requests than the run gets to make. */
  const STEPS = 3;

  it('sends no further model request, and the run settles as inactive', async () => {
    const requests: Held<CompletionResult>[] = [];
    // Ignores its signal, as a CLI provider mid-request may: the answer still arrives after the abort.
    const complete = (req: CompletionRequest) => new Promise<CompletionResult>((resolve) => requests.push({ signal: req.signal, answer: resolve }));
    const t = testPlugin(core, { archive: { channels: [{ id: 'c1' }] }, ai: claude(complete) });
    onTestFinished(() => t.dispose());
    const run = t.client('renderer').run(STEPS);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await t.off();
    expect(requests[0]!.signal?.aborted).toBe(true);
    requests[0]!.answer({ text: 'late' });
    await expect(run).rejects.toBeInstanceOf(PluginInactiveError);
    expect(requests).toHaveLength(1);
  });
});

describe('a plugin turned off and on while Jev answers', () => {
  const answer = (noul: number) => ({ worth: { type: 'noul', noul } });
  /** The new activation's answer, then the retired one's late answer. */
  const FRESH = 0.4;
  const STALE = 0.9;

  it("keeps the new activation's answer: the retired one's late answer is dropped", async () => {
    const jev = heldJev();
    const t = testPlugin(core, { archive: { channels: [{ id: 'c1' }] }, ai: { jev, switches: { judging: true } } });
    onTestFinished(() => t.dispose());
    const kept = () => t.db.prepare('SELECT noul FROM p_lifetimeprobe_answers').pluck().all();
    await vi.waitFor(() => expect(jev.held).toHaveLength(1));
    await t.off();
    await t.on();
    await vi.waitFor(() => expect(jev.held).toHaveLength(2));
    jev.held[1]!.answer(answer(FRESH));
    await vi.waitFor(() => expect(kept()).toEqual([FRESH]));
    expect(jev.held[0]!.signal?.aborted).toBe(true);
    jev.held[0]!.answer(answer(STALE));
    await new Promise((r) => setImmediate(r));
    expect(kept()).toEqual([FRESH]);
  });
});

describe('a plugin turned off while its Jev requests queue', () => {
  const COUNT = 8;
  /** Jev's shared cap on requests in flight (jev.ts MAX_IN_FLIGHT). */
  const IN_FLIGHT = 4;
  const COST_USD = 0.01;
  const route: JevRoute = { label: 'test', endpoint: 'https://jev.test/decide', wireModel: 'jev', headers: {}, errorText: () => 'failed', cost: (u) => u?.cost ?? null };
  afterEach(() => vi.unstubAllGlobals());

  it('stops queued requests from being sent and keeps what the answered ones cost', async () => {
    const sent: { questions: Record<string, unknown>; reply(): void }[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      sent.push({
        questions: body.questions,
        reply: () => resolve(new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { noul: 0.1 }])), usage: { cost: COST_USD } }))),
      });
    }));
    // The real Jev client over a stubbed network: it holds the in-flight cap.
    const jev = new JevProvider(() => undefined).via(route);
    const t = testPlugin(core, { archive: { channels: [{ id: 'c1' }] }, ai: { jev, switches: { judging: true } } });
    onTestFinished(() => t.dispose());
    // The activation's own request takes one in-flight place: answer it first.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent[0]!.reply();
    const run = t.client('renderer').judgeMany(COUNT);
    await vi.waitFor(() => expect(sent).toHaveLength(1 + IN_FLIGHT));
    sent[1]!.reply();
    await vi.waitFor(() => expect(sent).toHaveLength(1 + IN_FLIGHT + 1));
    await t.off();
    const result = await run;
    expect(sent).toHaveLength(1 + IN_FLIGHT + 1);
    expect(result).toMatchObject({ asked: COUNT, costUsd: COST_USD });
  });
});
