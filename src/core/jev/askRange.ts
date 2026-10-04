// Custom Jev calls over a range: the owner's own question asked about each recent message of a channel, ranked.
// On demand only; one request per message so the question can refer to `message` as everywhere else.
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

/**
 * Asks the question about each of the channel's latest `limit` messages (threads included), newest first, and returns
 * them ranked by Jev's value (highest first). Refuses local-AI-only channels and leaves out local-AI-only threads; failed
 * requests are just left out.
 */
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
