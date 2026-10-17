// Overlapping waits for history: each asked channel gets its own answer, ending only when every thread it covers has.
import { describe, expect, it } from 'vitest';
import { HistoryReaches } from '../src/main/sync/historyReach';

const PARENT = '200000000000000001';
const THREAD = '300000000000000001';
const SHALLOW = 1000;
const DEEP = 500;

/**
 * Whether `p` has settled, without waiting for it: settlement is recorded, then a macrotask barrier lets every queued promise
 * reaction run first. (Racing `p` against a resolved promise always answers false.)
 */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe('overlapping history waits', () => {
  it("answers a thread asked for after its parent's wait included it with its own channel", async () => {
    const r = new HistoryReaches();
    const parent = r.ask(PARENT, SHALLOW);
    r.include(PARENT, [THREAD]);
    const thread = r.ask(THREAD, DEEP);
    expect(r.sinceMs(THREAD)).toBe(DEEP);
    r.done(PARENT, 'reached');
    r.done(THREAD, 'reached');
    expect([await parent, await thread]).toEqual([{ channelId: PARENT, outcome: 'reached' }, { channelId: THREAD, outcome: 'reached' }]);
  });

  it("ends a parent's wait only once a thread with its own shallower wait reaches the parent's depth", async () => {
    const r = new HistoryReaches();
    const thread = r.ask(THREAD, SHALLOW);
    const parent = r.ask(PARENT, DEEP);
    r.include(PARENT, [THREAD]);
    expect(r.sinceMs(THREAD)).toBe(DEEP);
    r.done(PARENT, 'reached');
    expect(await settled(parent)).toBe(false);
    r.done(THREAD, 'failed', 'Discord said no');
    expect([await parent, await thread]).toEqual([
      { channelId: PARENT, outcome: 'failed', message: 'Discord said no' },
      { channelId: THREAD, outcome: 'failed', message: 'Discord said no' },
    ]);
  });

  it('gives a deeper ask after the parent phase ended its own wait, which its threads join', async () => {
    const r = new HistoryReaches();
    const first = r.ask(PARENT, SHALLOW);
    r.include(PARENT, [THREAD]);
    r.done(PARENT, 'reached');
    const deeper = r.ask(PARENT, DEEP);
    r.include(PARENT, [THREAD]);
    expect(r.sinceMs(THREAD)).toBe(DEEP);
    r.done(PARENT, 'reached');
    expect([await settled(first), await settled(deeper)]).toEqual([false, false]);
    r.done(THREAD, 'reached');
    expect([await first, await deeper]).toEqual([{ channelId: PARENT, outcome: 'reached' }, { channelId: PARENT, outcome: 'reached' }]);
  });
});
