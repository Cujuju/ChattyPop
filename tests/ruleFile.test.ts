import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleAction } from '@shared/rules';
import type { RuleFileFormat } from '@shared/ruleKinds/host';
import { newRuleAction } from '@shared/ruleSpec';
import { tempDir } from './helpers';
import { ruleHarness, ruleInput, runsOf, type Harness } from './ruleHarness';

let h: Harness;
let dir: string;
beforeEach(() => {
  h = ruleHarness();
  dir = tempDir();
});

const fileAt = (path: string, format: RuleFileFormat): RuleAction =>
  ({ ...newRuleAction('file'), config: { path, format } }) as RuleAction;
/** Waits for `count` runs of the rule's one action to record their outcomes (the append is real file I/O). */
const runsSettled = (id: number, count: number) =>
  vi.waitFor(() => expect(runsOf(h, id).filter((r) => r[2].length === 1)).toHaveLength(count));

describe('rule file action', () => {
  it('appends one Markdown line per message, once, with author, channel and a link to it', async () => {
    const path = join(dir, 'log.md');
    const id = h.rules.create(ruleInput([fileAt(path, 'markdown')], { gates: { edits: true } }));
    const m = h.say('first line\nsecond line');
    h.say('another');
    await runsSettled(id, 2);
    h.archive.applyUpdate({ ...m, content: 'edited' }); // the rule takes edits, but already ran on this message (claims are synchronous)
    expect(runsOf(h, id)).toHaveLength(2);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^- \d{4}-\d\d-\d\d \d\d:\d\d · #c1 · u2: first line second line \(\[open\]\(https:\/\/discord\.com\/channels\/.+\/c1\/.+\)\)$/,
    );
    expect(runsOf(h, id).map((r) => r[2])).toEqual([['done'], ['done']]);
  });

  it('writes JSON Lines objects', async () => {
    const path = join(dir, 'log.jsonl');
    const id = h.rules.create(ruleInput([fileAt(path, 'jsonl')], { name: 'Sales' }));
    const m = h.say('50% off');
    await runsSettled(id, 1);
    const row = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    expect(row).toMatchObject({ rule: 'Sales', messageId: m.id, channelId: 'c1', authorId: 'u2', text: '50% off' });
  });

  it('records a failure when the folder is missing, and refuses files that could run as code', async () => {
    const id = h.rules.create(ruleInput([fileAt(join(dir, 'missing', 'log.md'), 'markdown')]));
    h.say('hello');
    await runsSettled(id, 1);
    expect(runsOf(h, id)[0]![2]).toEqual(['failed']);
    expect(() => h.rules.create(ruleInput([fileAt(join(dir, 'run.cmd'), 'markdown')]))).toThrow(/must end in/);
    expect(() => h.rules.create(ruleInput([fileAt(join(dir, 'log.md'), 'jsonl')]))).toThrow(/must end in/);
  });
});
