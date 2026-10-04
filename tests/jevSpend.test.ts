import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDay } from '@shared/jevSpend';
import { JEV_OPENROUTER_MODEL } from '@shared/openrouter';
import { DEFAULT_AI_SETTINGS } from '@shared/settings';
import { MS_PER_DAY } from '@shared/units';
import { ProviderRegistry } from '../src/core/ai/registry';
import { JevSpendLedger } from '../src/core/jevSpend';
import { tempDb } from './helpers';

describe('every answered Jev request reaches the spend ledger', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports question count, price and tokens, and nothing for a failed request', async () => {
    const spent: unknown[][] = [];
    const reg = new ProviderRegistry((q, usd, tokens) => spent.push([q, usd, tokens]));
    reg.setOpenRouterKeys([{ id: 'jev', label: 'jev', key: 'sk-jev', hint: '…', models: [JEV_OPENROUTER_MODEL], anyModel: false }]);
    const jev = reg.decider({ ...DEFAULT_AI_SETTINGS, jev: { ...DEFAULT_AI_SETTINGS.jev, 'summaries.citationCheck': true } }, 'summaries.citationCheck')!;
    const replies = [
      { ok: true, status: 200, json: { answers: {}, usage: { cost: 0.00003, input_tokens: 812, output_tokens: 9 } } },
      { ok: true, status: 200, json: { answers: {} } },
      { ok: false, status: 500, json: { error: 'down' } },
    ];
    vi.stubGlobal('fetch', async () => {
      const r = replies.shift()!;
      return { ok: r.ok, status: r.status, headers: new Headers(), json: async () => r.json };
    });
    const q = { type: 'noul', instructions: 'q' } as const;
    await jev.decide({ state: 'x', questions: { a: q, b: q } });
    await jev.decide({ state: 'x', questions: { a: q } });
    await expect(jev.decide({ state: 'x', questions: { a: q } })).rejects.toThrow();
    expect(spent).toEqual([
      [2, 0.00003, { input: 812, output: 9 }],
      [1, null, null],
    ]);
  });
});

describe('spend ledger', () => {
  it('totals cost and tokens per local day, keeps unpriced requests out of the rate, and reports after writing', () => {
    const db = tempDb();
    const reports: unknown[] = [];
    const ledger = new JevSpendLedger(() => db, (s) => reports.push(s));
    const now = Date.now();
    const tok = (input: number, output: number) => ({ input, output });
    ledger.record(20, 0.0002, tok(5000, 60), now - MS_PER_DAY);
    ledger.record(1, 0.00002, tok(300, 3), now);
    ledger.record(3, null, null, now);
    ledger.flush();
    ledger.record(1, 0.00002, tok(300, 3), now); // a second flush adds to the same day
    ledger.flush();
    const s = ledger.spend(db, now);
    expect(s.days).toEqual([
      { day: localDay(now - MS_PER_DAY), usd: 0.0002, inputTokens: 5000, outputTokens: 60 },
      { day: localDay(now), usd: expect.closeTo(0.00004, 10), inputTokens: 600, outputTokens: 6 },
    ]);
    expect(s).toMatchObject({ requests: 4, unpricedRequests: 1, tokenlessRequests: 1, inputTokens: 5600, outputTokens: 66, totalUsd: expect.closeTo(0.00024, 10) });
    expect(s.usdPerQuestion).toBeCloseTo(0.00024 / 22, 12);
    expect(reports).toHaveLength(2);
  });

  it('keeps the tally while the database is closed', () => {
    const db = tempDb();
    let open = false;
    const ledger = new JevSpendLedger(() => (open ? db : null), () => {});
    ledger.record(1, 0.00001, null);
    ledger.flush();
    open = true;
    ledger.flush();
    expect(ledger.spend(db).requests).toBe(1);
  });
});
