// File-action appends land in fire order even when the OS completes them in another order.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuleAction } from '@shared/rules';
import { newRuleAction } from '@shared/ruleSpec';
import { tempDir } from './helpers';
import { ruleHarness, ruleInput, runsOf } from './ruleHarness';

/** Appends the OS has accepted but not completed; the test completes them in the order it chooses. */
const held: { data: string; done: () => void }[] = [];
/** What each completed append wrote, in completion order. */
const written: string[] = [];
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  appendFile: (_path: string, data: string) =>
    new Promise<void>((resolve) => held.push({ data, done: resolve })),
}));

/** Completes the newest held append first, as an OS may, until none is left. */
async function completeNewestFirst(expected: number): Promise<void> {
  for (let n = 0; n < expected; n++) {
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    const last = held.pop()!;
    written.push(last.data);
    last.done();
  }
}

describe('rule file action ordering', () => {
  it('appends to one file in the order the rules fired, across rules', async () => {
    const h = ruleHarness();
    const path = join(tempDir(), 'log.md');
    const file = { ...newRuleAction('file'), config: { path, format: 'markdown' } } as RuleAction;
    const a = h.rules.create(ruleInput([file], { name: 'A' }));
    const b = h.rules.create(ruleInput([file], { name: 'B' }));
    h.say('first');
    h.say('second');
    await completeNewestFirst(4);
    await vi.waitFor(() => expect([...runsOf(h, a), ...runsOf(h, b)].filter((r) => r[2].length === 1)).toHaveLength(4));
    expect(written.map((l) => l.match(/: (\w+) \(/)![1])).toEqual(['first', 'first', 'second', 'second']);
  });
});
