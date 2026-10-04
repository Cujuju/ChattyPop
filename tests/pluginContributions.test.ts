// Contract tests for plugin contributions.
import { afterEach, expect, it, vi } from 'vitest';
import { registerUsage, usageSince } from '../src/core/ai/usage';
import { TEXT_COVERED_SQL, loadTextCoverage, registerTextCoverage } from '../src/core/textCoverage';
import { tempDb } from './helpers';

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); });
const own = (dispose: () => void) => { disposers.push(dispose); return dispose; };
const empty = { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

it('sums active owners for the requested provider window and removes only the disabled owner', () => {
  expect(usageSince('codex', 100)).toEqual(empty);
  const first = vi.fn(() => ({ runs: 2, inputTokens: 10, cachedInputTokens: 3, outputTokens: 4 }));
  const second = vi.fn(() => ({ runs: 1, inputTokens: 20, cachedInputTokens: 7, outputTokens: 8 }));
  const disableFirst = own(registerUsage(first));
  const disableSecond = own(registerUsage(second));
  expect(usageSince('codex', 100)).toEqual({ runs: 3, inputTokens: 30, cachedInputTokens: 10, outputTokens: 12 });
  expect(first).toHaveBeenCalledWith('codex', 100);
  expect(second).toHaveBeenCalledWith('codex', 100);
  disableFirst();
  disableFirst();
  expect(usageSince('claude', 200)).toEqual({ runs: 1, inputTokens: 20, cachedInputTokens: 7, outputTokens: 8 });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenLastCalledWith('claude', 200);
  disableSecond();
  expect(usageSince('codex', 100)).toEqual(empty);
  own(registerUsage(first));
  expect(usageSince('codex', 100)).toEqual({ runs: 2, inputTokens: 10, cachedInputTokens: 3, outputTokens: 4 });
});

it('permits text removal covered by either active owner, but none when owners are absent or disabled', () => {
  const db = tempDb();
  // Messages 1-3 in channel c at ts 10, 20, 30; message 4 in channel d at ts 20.
  const covered = () => {
    loadTextCoverage(db);
    return db.prepare(`SELECT m.id FROM (
      SELECT 1 AS id, 'c' AS channel_id, 10 AS ts UNION ALL SELECT 2, 'c', 20 UNION ALL SELECT 3, 'c', 30 UNION ALL SELECT 4, 'd', 20
    ) m WHERE ${TEXT_COVERED_SQL} ORDER BY m.id`).pluck().all();
  };
  expect(covered()).toEqual([]);
  let since = 10;
  const first = () => [{ channelIds: ['c'], since, until: since }];
  const disableFirst = own(registerTextCoverage(first));
  const disableSecond = own(registerTextCoverage(() => [{ channelIds: ['c', 'd'], since: 20, until: 20 }]));
  expect(covered()).toEqual([1, 2, 4]);
  since = 30;
  expect(covered()).toEqual([2, 3, 4]);
  disableFirst();
  disableFirst();
  expect(covered()).toEqual([2, 4]);
  disableSecond();
  expect(covered()).toEqual([]);
  own(registerTextCoverage(first));
  expect(covered()).toEqual([3]);
});
