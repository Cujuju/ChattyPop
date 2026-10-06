// Compiles rule gates/regexes per reload. Message facts load lazily once; gates, narrowing and direct matches require no Jev.
import type { Platform } from '@shared/links';
import type { ContentKind } from '@shared/messageContent';
import { runsOnMissed, type RuleSpec } from '@shared/rules';
import type { RawUser } from '@shared/discord';
import type { Hit } from './hit';
import type { Db } from '../db';
import { THREAD_KINDS_SQL } from '../queries/channelScope';
import { contentReader } from '../queries/messageContent';
import type { TextMessage } from '../arrival';
import type { QuestionContext } from '../jev/messageQuestions';
import type { RuleKinds, PreparedMatch, PreparedFilter, MatchContext } from './kinds';
import type { LoadedRule } from './ruleStore';

/** A rule ready to evaluate: its spec, and its conditions as sets and a regex. */
export interface CompiledRule {
  id: number;
  name: string;
  armedAt: number;
  discordSend: boolean;
  builtin: string | null;
  spec: RuleSpec;
  guilds: Set<string> | null;
  channels: Set<string> | null;
  authors: Set<string> | null;
  managed: string | null;
  matches: PreparedMatch[];
  filters: PreparedFilter[];
  /** Nothing in its match: the gates and narrowing alone decide (e.g. every voice message). */
  byNarrow: boolean;
}

const setOf = <T>(xs: T[] | undefined): Set<T> | null => (xs?.length ? new Set(xs) : null);
/** A site as written: lowercase, without a leading "www.". */
const site = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');

/** An enabled rule whose spec reads, ready to evaluate; null otherwise. Throws never: a bad pattern was refused on save. */
export function compileRule(r: LoadedRule, kinds: RuleKinds): CompiledRule | null {
  if (!r.spec || r.row.enabled !== 1) return null;
  if (kinds.unavailableRule(r.spec)) return null;
  try {
    const { gates, match, narrow } = r.spec;
    return {
      id: r.row.id,
      name: r.row.name,
      armedAt: r.row.armed_at,
      discordSend: r.row.discord_send === 1,
      builtin: r.row.builtin,
      spec: r.spec,
      guilds: setOf(gates.guildIds),
      channels: setOf(gates.channelIds),
      authors: setOf(gates.authorIds),
      managed: r.row.builtin,
      matches: match.map((p) => kinds.prepareMatch(p)),
      filters: narrow.map((p) => kinds.prepareFilter(p)),
      byNarrow: !match.length,
    };
  } catch {
    return null;
  }
}

/** What one message is: where it is, what it carries, its links and tags; each read from the database once, when first asked. */
export class MessageFacts {
  private placeRow?: { guildId: string | null; parentId: string | null };
  private kinds?: Set<ContentKind>;
  private linkRows?: { platform: Platform; host: string }[];
  private readonly memoized = new Map<string, unknown>();

  constructor(
    private readonly db: Db,
    private readonly readContents: (messageId: string) => Set<ContentKind>,
    readonly m: TextMessage,
  ) {}

  place(): { guildId: string | null; parentId: string | null } {
    this.placeRow ??= (this.db
      .prepare(
        `SELECT guild_id AS guildId, CASE WHEN kind IN (${THREAD_KINDS_SQL}) THEN parent_id END AS parentId FROM channels WHERE id = ?`,
      )
      .get(this.m.channelId) as { guildId: string | null; parentId: string | null } | undefined) ?? {
      guildId: null,
      parentId: null,
    };
    return this.placeRow;
  }

  contents(): Set<ContentKind> {
    this.kinds ??= this.readContents(this.m.id);
    return this.kinds;
  }

  links(): { platform: Platform; host: string }[] {
    this.linkRows ??= (
      this.db
        .prepare(
          'SELECT l.platform, l.url FROM message_links ml JOIN links l ON l.id = ml.link_id WHERE ml.message_id = ?',
        )
        .all(this.m.id) as { platform: Platform; url: string }[]
    ).map((l) => ({ platform: l.platform, host: hostOf(l.url) }));
    return this.linkRows;
  }

  /** Reads once per message, including a result of undefined. */
  memo<T>(key: string, read: () => T): T {
    if (!this.memoized.has(key)) this.memoized.set(key, read());
    return this.memoized.get(key) as T;
  }

  /** A view whose memo keys belong to one plugin; host reads retain their shared cache. */
  scoped(pluginId: string): MessageFacts {
    const view = Object.create(this) as MessageFacts;
    view.place = this.place.bind(this);
    view.contents = this.contents.bind(this);
    view.links = this.links.bind(this);
    view.memo = (key, read) => this.memo(`${pluginId}\0${key}`, read);
    return view;
  }
}

function hostOf(url: string): string {
  try {
    return site(new URL(url).hostname);
  } catch {
    return '';
  }
}

/** Builds MessageFacts for messages of one database; the contents query is prepared once. */
export const factsReader = (db: Db): ((m: TextMessage) => MessageFacts) => {
  const read = contentReader(db);
  return (m) => new MessageFacts(db, read, m);
};

/** Checks armed time, edits, missed messages, author and location in cost order. Missed messages require both acceptance and an applicable action. */
export function gatesPass(r: CompiledRule, f: MessageFacts, a: QuestionContext): boolean {
  const { m } = f;
  const g = r.spec.gates;
  if (m.ts < r.armedAt || (a.edit && !g.edits)) return false;
  if (!a.live && !(g.missed && r.spec.actions.some(runsOnMissed))) return false;
  return scopePasses(r, f);
}

/** Where and who only: the gates a message older than the rule (history) is held to. */
export function scopePasses(r: CompiledRule, f: MessageFacts): boolean {
  const { m } = f;
  if (r.authors && r.authors.has(m.authorId) === !!r.spec.gates.authorsNot) return false;
  if (r.channels && !r.channels.has(m.channelId) && !r.channels.has(f.place().parentId ?? '')) return false;
  return !r.guilds || r.guilds.has(f.place().guildId ?? '');
}

/** Every narrowing filter must hold. */
export function narrowPasses(r: CompiledRule, facts: MessageFacts): boolean {
  return r.filters.every((f) => f.test(f.config, { m: facts.m, facts }));
}

/** The message, cached facts and rule identity available to direct matches and Jev questions. */
export const matchContext = (r: CompiledRule, facts: MessageFacts, self: RawUser | null = null): MatchContext => ({
  m: facts.m,
  facts,
  rule: r,
  self,
});
/** A match needing no Jev after gates and narrowing pass; any direct match suffices, or narrowing alone when no match parts exist. */
export function directMatch(r: CompiledRule, facts: MessageFacts, self: RawUser | null = null): Hit | null {
  if (r.byNarrow) return { kind: 'pattern', probability: null, highlight: null };
  for (const p of r.matches) {
    const hit = p.direct?.(p.config, matchContext(r, facts, self));
    if (hit) return hit;
  }
  return null;
}

/** The rule’s Jev question, or null when no registered match asks one; built-in owner questions require the owner to be known. */
export function questionMatch(r: CompiledRule, facts: MessageFacts, self: RawUser | null) {
  for (const p of r.matches) {
    const question = p.question?.(p.config, matchContext(r, facts, self));
    if (question) return question;
  }
  return null;
}
