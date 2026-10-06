// Jev spend ledger: every Jev request's reported cost, per local day, for the status bar and cost projections.
import { localDay, recentFromDay, type JevSpend } from '@shared/jevSpend';
import type { JevTokens } from './ai/jev';
import type { Db } from './db';

/** Writes are batched: Jev runs up to four requests at once, often hundreds in a burst. */
const FLUSH_MS = 1000;

interface Tally {
  requests: number;
  pricedQuestions: number;
  usd: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  tokenless: number;
}

const empty = (): Tally => ({ requests: 0, pricedQuestions: 0, usd: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, tokenless: 0 });

/** Buffers spend for FLUSH_MS, including while the database is closed. Abrupt termination can lose the latest buffer; flushes report updated spend. */
export class JevSpendLedger {
  private readonly pending = new Map<string, Tally>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: () => Db | null,
    private readonly changed: (spend: JevSpend) => void,
  ) {}

  /** One answered request: how many questions it asked, and its price and tokens when the service reported them. */
  record(questions: number, usd: number | null, tokens: JevTokens | null, at = Date.now()): void {
    const day = localDay(at);
    const t = this.pending.get(day) ?? empty();
    t.requests++;
    if (usd === null) t.unpriced++;
    else {
      t.usd += usd;
      t.pricedQuestions += questions;
    }
    if (tokens === null) t.tokenless++;
    else {
      t.inputTokens += tokens.input;
      t.outputTokens += tokens.output;
    }
    this.pending.set(day, t);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush(): void {
    this.timer = undefined;
    const db = this.db();
    if (!this.pending.size) return;
    if (!db?.open) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO jev_spend (day, requests, priced_questions, usd, unpriced_requests, input_tokens, output_tokens, tokenless_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests, priced_questions = priced_questions + excluded.priced_questions,
         usd = usd + excluded.usd, unpriced_requests = unpriced_requests + excluded.unpriced_requests,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         tokenless_requests = tokenless_requests + excluded.tokenless_requests`,
    );
    db.transaction(() => {
      for (const [day, t] of this.pending) upsert.run(day, t.requests, t.pricedQuestions, t.usd, t.unpriced, t.inputTokens, t.outputTokens, t.tokenless);
    })();
    this.pending.clear();
    this.changed(this.spend(db));
  }

  spend(db: Db, now = Date.now()): JevSpend {
    const from = recentFromDay(now);
    const days = db
      .prepare('SELECT day, usd, input_tokens AS inputTokens, output_tokens AS outputTokens FROM jev_spend WHERE day >= ? ORDER BY day')
      .all(from) as JevSpend['days'];
    const all = db
      .prepare(
        `SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(unpriced_requests), 0) AS unpriced,
                COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(tokenless_requests), 0) AS tokenless
         FROM jev_spend`,
      )
      .get() as { usd: number; requests: number; unpriced: number; input: number; output: number; tokenless: number };
    const recent = db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(priced_questions), 0) AS q FROM jev_spend WHERE day >= ?').get(from) as {
      usd: number;
      q: number;
    };
    return {
      days,
      totalUsd: all.usd,
      inputTokens: all.input,
      outputTokens: all.output,
      requests: all.requests,
      tokenlessRequests: all.tokenless,
      unpricedRequests: all.unpriced,
      usdPerQuestion: recent.q ? recent.usd / recent.q : null,
    };
  }
}
