// Host match, filter and window-trigger implementations.
import { buildPattern, compileKeywordPattern } from '@shared/keywordPattern';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import type { TextConfig } from '@shared/ruleKinds/host';
import type { ContentKind } from '@shared/messageContent';
import type { Platform } from '@shared/links';
import { ruleSubject } from '@shared/rules';
import { dueWindow, type TimedTrigger } from '@shared/ruleTime';
import { queryMatch, queryRequest, specMatch } from '../jev/queries';
import { customQuestion, QUERY } from '../jev/questions';
import type { RuleKinds } from './kinds';

/** Registers prepared host matching and narrowing, plus scheduled-window calculation. */
export function registerHostMatches(k: RuleKinds): void {
  k.match<TextConfig, RegExp>('text', {
    prepare: (c) => compileKeywordPattern(c.spec ? buildPattern(c.spec) : c.pattern),
    direct: (re, { m }) =>
      m.content && re.test(m.content) ? { kind: 'pattern', probability: null, highlight: re } : null,
  });
  k.match<string>('meaning', {
    question: (topic, { rule }) => ({
      subject: ruleSubject(rule.id),
      features: ['topicMeaning'],
      question: queryRequest(QUERY.meaning, { vars: { topic } }),
      match: (a) => queryMatch(QUERY.meaning, a),
    }),
  });
  k.match<CustomJevQuestion>('jev', {
    question: (c, { rule }) => ({
      subject: ruleSubject(rule.id),
      features: ['ruleQuestions'],
      question: customQuestion(c),
      match: specMatch(c),
    }),
  });
  k.filter<ContentKind[]>('contains', { test: (c, { facts }) => !c.length || c.some((x) => facts.contents().has(x)) });
  k.filter<Platform[]>('linkPlatforms', {
    test: (c, { facts }) => !c.length || facts.links().some((l) => c.includes(l.platform)),
  });
  k.filter<string[]>('linkDomains', {
    prepare: (c) =>
      c.map((s) =>
        s
          .trim()
          .toLowerCase()
          .replace(/^www\./, ''),
      ),
    test: (c, { facts }) =>
      !c.length || facts.links().some((l) => c.some((d) => l.host === d || l.host.endsWith(`.${d}`))),
  });
  k.windows.register('timed', {
    due: (config, state) => {
      const t = config as TimedTrigger;
      const due = dueWindow(t, state);
      return due ? { ...due, timing: t.kind } : null;
    },
    oncePerSession: (c) => (c as TimedTrigger).kind === 'appStart',
  });
}
