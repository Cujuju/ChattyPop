import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { startupFixture, STARTUP_CHANNELS, STARTUP_MESSAGES, STARTUP_RECENT } from './startupFixture';
import { hostRuleStack } from './hostRules';
import { Archive } from '../src/core/archive';
import { savedWritableChannels } from '../src/core/queries/savedMessages';
import { ownCommands } from '../src/core/queries/ownCommands';
import { ownEmoji, ownReactions } from '../src/core/queries/ownEmoji';
import { closeArchiveReads, configureArchiveReads } from '../src/core/reads/archiveReads';
import { legacySavedWritableChannels, legacySetSelf } from './startupLegacy';
import { ownCommandsAsync, ownEmojiAsync, ownReactionsAsync, savedWritableChannelsAsync, syncStateAsync } from '../src/core/queries/hostAsync';
import { archiveReplyTargets } from '../src/core/plugins/archiveReplies';
import { registerMessageQuestion } from '../src/core/jev/messageQuestions';
import { FakeJev } from './fakeJev';
import { startupTurns } from './startupTurns';

/** Includes native fixture insertion on a shared machine, outside the measured calls. */
const FIXTURE_TIMEOUT_MS = 180_000;
/** This task targets second-long Core turns, independently of total asynchronous latency. */
const CORE_TURN_MAX_MS = 1000;

/** Opt-in real-scale benchmark; contract tests use small fixtures. */
describe.runIf(process.env.CHATTYPOP_STARTUP_BENCH === '1')('startup Core turns at archive scale', () => {
  it('records synchronous reference costs on a disposable archive', async () => {
    const db = startupFixture();
    const provider = new FakeJev();
    const { matcher } = hostRuleStack(db, () => {}, () => provider);
    const nextMatcher = hostRuleStack(db, () => {}, () => provider).matcher;
    // A host probe reproduces the indexed payload lookup used by owner-directed rule matching.
    const unregister = registerMessageQuestion({ subject: 'startup-probe', feature: 'topicMeaning', question: (m) => {
      archiveReplyTargets(db, [m.id]); return null;
    } });
    const archive = new Archive(db);
    const rows: Record<string, number> = {};
    const measure = (name: string, fn: () => unknown) => {
      const start = performance.now(); fn(); rows[name] = performance.now() - start;
    };
    try {
      measure('setSelf', () => legacySetSelf(matcher, db, { id: 'owner', username: 'owner' }));
      measure('savedWritableChannels', () => legacySavedWritableChannels(db, 'owner'));
      measure('savedWritableChannelsBatched', () => savedWritableChannels(db, 'owner'));
      measure('ownCommands', () => ownCommands(db, 'owner', 50));
      measure('ownEmoji', () => ownEmoji(db, 'owner', 50));
      measure('ownReactions', () => ownReactions(db, 50));
      measure('syncState', () => archive.syncState('c0'));
      const after: Record<string, unknown> = {};
      for (const [name, fn] of Object.entries({
        setSelf: async () => { nextMatcher.setSelf({ id: 'owner', username: 'owner' }); await nextMatcher.catchUpJudgments(); },
        savedWritableChannels: () => savedWritableChannelsAsync(db, 'owner'),
        ownCommands: () => ownCommandsAsync(db, 'owner', 50),
        ownEmoji: () => ownEmojiAsync(db, 'owner', 50),
        ownReactions: () => ownReactionsAsync(db, 50),
        syncState: () => syncStateAsync(db, 'c0'),
      })) {
        await closeArchiveReads(db);
        configureArchiveReads(db, null);
        const { value, ...timing } = await startupTurns<unknown>(fn);
        after[name] = timing;
        expect(timing.longestTurnMs).toBeLessThan(CORE_TURN_MAX_MS);
        if (name === 'savedWritableChannels') expect(value).toEqual(legacySavedWritableChannels(db, 'owner'));
      }
      process.stdout.write(JSON.stringify({ channels: STARTUP_CHANNELS, messages: STARTUP_MESSAGES, recent: STARTUP_RECENT, synchronousMs: rows, after }) + '\n');
    } finally { unregister(); matcher.dispose(); nextMatcher.dispose(); await closeArchiveReads(db); db.close(); }
  }, FIXTURE_TIMEOUT_MS);
});
