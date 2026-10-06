// On-demand custom Jev questions rank recent channel messages. Each message gets an independent request with message state.
import type { JevAskResult, JevRangeAsk } from '@shared/contract';
import { validateJevSpec } from '@shared/jevQuestion';
import { answerValue, sumCosts, type Answer, type DecisionProvider } from '../ai/decisions';
import { assertHostedMayRead, hostedMayReadSql } from '../channelPolicy';
import type { Db } from '../db';
import { inChannelOrChildSql } from '../queries/channelScope';
import { MESSAGE_TEXT_SQL, TEXT_MESSAGE_COLUMNS, clampCount } from '../queries/messageText';
import type { TextMessage } from '../arrival';
import type { MessageJudge } from './messageJudge';
import { customQuestion } from './questions';

/** Upper bound on messages asked about in one run: bounds cost (~$0.00002 each) and time (4 requests in flight). */
export const ASK_RANGE_MAX = 400;

/** Ranks latest channel messages, including threads, by Jev value. Refuses local-only channels, excludes local-only threads and omits failed requests. */
export async function askRange(db: Db, judge: MessageJudge, jev: DecisionProvider, ask: JevRangeAsk): Promise<JevAskResult> {
  validateJevSpec(ask.question);
  assertHostedMayRead(db, ask.channelId);
  const limit = clampCount(ask.limit, ASK_RANGE_MAX);
  const messages = db
    .prepare(
      `SELECT ${TEXT_MESSAGE_COLUMNS} FROM messages m
       WHERE ${MESSAGE_TEXT_SQL} != '' AND ${inChannelOrChildSql('@channel')} AND ${hostedMayReadSql('m.channel_id')}
       ORDER BY m.ts DESC LIMIT @limit`,
    )
    .all({ channel: ask.channelId, limit }) as TextMessage[];
  const question = customQuestion(ask.question);
  const costs: number[] = [];
  let failed = 0;
  const hits = await Promise.all(
    messages.map(async (m) => {
      try {
        const r = await jev.decide({ state: judge.stateFor(m), questions: { ask: question } });
        if (r.costUsd !== null) costs.push(r.costUsd);
        const a = r.answers.ask as Answer | undefined;
        return a ? { messageId: m.id, channelId: m.channelId, ts: m.ts, content: m.content, ...answerValue(a) } : null;
      } catch {
        failed++;
        return null;
      }
    }),
  );
  const results = hits.filter((h): h is NonNullable<typeof h> => h !== null).sort((a, b) => b.value - a.value || b.ts - a.ts);
  return { kind: ask.question.type, results, asked: messages.length, failed, costUsd: sumCosts(costs) };
}
