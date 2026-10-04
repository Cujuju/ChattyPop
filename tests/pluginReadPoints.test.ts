// Contract probes for page labels, search conditions, people readers, memoization and dynamic Jev questions.
import { describe, expect, it, vi } from 'vitest';
import { checkBundled } from '@shared/bundledCheck';
import { parseSearchQuery } from '@shared/searchQuery';
import { factsReader } from '../src/core/rules/compile';
import { messageQuestions } from '../src/core/jev/messageQuestions';
import { parseSearch, searchMessages } from '../src/core/queries/search';
import { textMessage } from '../src/core/queries/messageText';
import { probe, startReadProbe as start } from './pluginReadHarness';

describe(
  'plugin page labels',
  () => {
    it(
      'stamps ownership, reads inside pages, refreshes, and drops registrations and held callbacks on disable',
      async () => {
        const h = start((ctx) => ctx.archive.messageLabels.provide((ids) => new Map(ids.map((id) => [id, [{
          subject: 'x',
          text: 'Probe',
          title: 'Hover',
          key: '7',
          variant: 'manual',
        }]]))));
        expect(h.page()[0]!.labels).toContainEqual({
          subject: 'x',
          text: 'Probe',
          title: 'Hover',
          key: '7',
          variant: 'manual',
          pluginId: 'readprobe',
        });
        h.context().archive.messageLabels.changed([h.raw.id]);
        expect(h.events).toContainEqual({
          type: 'message-labels-changed',
          messageIds: [h.raw.id],
        });
        await h.host.setEnabled('readprobe', false);
        h.events.length = 0;
        h.context().archive.messageLabels.changed(null);
        h.context().archive.messageLabels.provide(() => new Map());
        expect(h.page()[0]!.labels).toEqual([]);
        expect(h.events).toEqual([]);
      },
    );
    it(
      "stamps a plugin Jev question's chip with its plugin, so a window hides it with its owner",
      () => {
        const h = start((ctx) => ctx.jev.questions.register({ subject: 'readprobe:q', feature: 'pluginDecide', question: () => null, label: (s) => s.label }));
        h.db.prepare("INSERT INTO jev_judgments (message_id, subject, value, label, model, judged_at) VALUES (?, 'readprobe:q', 1, 'probed', 'fake', 0)").run(h.raw.id);
        expect(h.page()[0]!.labels).toEqual([
          { subject: 'readprobe:q', text: 'probed', title: "Jev's label for this message (a model's estimate)", pluginId: 'readprobe' },
        ]);
      },
    );
    it(
      'records a throwing provider on its plugin without failing the page',
      () => {
        const h = start((ctx) => ctx.archive.messageLabels.provide(() => {
          throw new Error('label failed');
        }));
        expect(h.page()[0]!.id).toBe(h.raw.id);
        expect(h.page()[0]!.labels).toEqual([]);
        expect(h.host.list()[0]!.error).toBe('label failed');
      },
    );
  },
);

describe(
  'plugin search tokens',
  () => {
    it(
      'binds values, supports quoted and negated tokens, and treats disabled or absent tokens as plain text',
      async () => {
        const read = vi.fn((value: string) => ({
          sql: 'm.id = ?',
          params: [value],
        }));
        const h = start((ctx) => ctx.search.token('probe', read));
        expect(searchMessages(h.db, `probe:${h.raw.id}`, 10, 'relevance').map((m) => m.messageId)).toEqual([h.raw.id]);
        const injection = "x' OR 1=1 --";
        expect(parseSearch(`-probe:"${injection}"`)).toEqual({
          words: '',
          where: ['NOT IFNULL(m.id = ?, 0)'],
          params: [injection],
        });
        expect(parseSearchQuery('probe:off', ['probe']).words).toBe('');
        await h.host.setEnabled('readprobe', false);
        expect(parseSearch('probe:off')).toEqual({
          words: 'probe:off',
          where: [],
          params: [],
        });
        expect(parseSearchQuery('probe:off')).toEqual({
          words: 'probe:off',
          terms: [],
          problems: [],
        });
      },
    );
    it(
      'refuses undeclared keys and host-key or duplicate declarations; failed conditions match nothing',
      async () => {
        const h = start((ctx) => ctx.search.token(
          'probe',
          () => {
            throw new Error('condition failed');
          },
        ));
        expect(() => h.context().search.token(
          'other',
          () => ({
            sql: '1',
            params: [],
          }),
        )).toThrow(/no declared/);
        expect(parseSearch('probe:x').where).toEqual(['0']);
        expect(h.host.list()[0]!.error).toBe('condition failed');
        expect(() => checkBundled([{
          ...probe,
          search: {
            tokens: [{
              key: 'from',
              description: 'From',
              value: 'name',
            }],
          },
        }])).toThrow(/Invalid/);
        expect(() => checkBundled([{
          ...probe,
          search: {
            tokens: [{
              key: 'probe',
              description: ' ',
              value: 'probe',
            }],
          },
        }])).toThrow(/needs a description/);
        expect(() => checkBundled([probe, {
          ...probe,
          manifest: {
            ...probe.manifest,
            id: 'second',
          },
        }])).toThrow(/search token/);
        await h.host.setEnabled('readprobe', false);
        h.context().search.token(
          'probe',
          () => ({
            sql: '1',
            params: [],
          }),
        );
        expect(parseSearch('probe:x').words).toBe('probe:x');
      },
    );
  },
);

describe(
  'people and dynamic questions',
  () => {
    it(
      'serves a person section through its declared channel; its retained reader becomes inert',
      async () => {
        const read = vi.fn((id: string) => ({ id }));
        let section!: (id: string) => { id: string } | null;
        const h = start((ctx) => {
          section = ctx.people.section(read);
          ctx.channels.serve({ person: section });
        });
        await expect(h.host.call('renderer', 'readprobe', 'person', ['u1'])).resolves.toEqual({ id: 'u1' });
        await expect(h.host.call('main', 'readprobe', 'person', ['u1'])).rejects.toThrow();
        await h.host.setEnabled('readprobe', false);
        expect(section('u2')).toBeNull();
        expect(read).toHaveBeenCalledTimes(1);
      },
    );
    it(
      'isolates a throwing person reader',
      async () => {
        const h = start((ctx) => ctx.channels.serve({
          person: ctx.people.section(() => {
            throw new Error('person failed');
          }),
        }));
        await expect(h.host.call('renderer', 'readprobe', 'person', ['u1'])).resolves.toBeNull();
        expect(h.host.list()[0]!.error).toBe('person failed');
      },
    );
    it(
      'returns idempotent question disposers that cannot remove a replacement, and unregisters on disable',
      async () => {
        const h = start(() => undefined);
        const answered = vi.fn();
        const question = {
          subject: 'readprobe:q',
          feature: 'pluginDecide' as const,
          question: () => null,
          onAnswer: answered,
        };
        const first = h.context().jev.questions.register(question);
        const retained = messageQuestions().find((q) => q.subject === question.subject)!;
        const second = h.context().jev.questions.register({ ...question });
        retained.onAnswer!(
          textMessage(h.db, h.raw.id)!,
          {
            type: 'noul',
            noul: 1,
          },
          null,
        );
        expect(answered).not.toHaveBeenCalled();
        first();
        first();
        expect(messageQuestions().filter((q) => q.subject === question.subject)).toHaveLength(1);
        second();
        expect(messageQuestions().some((q) => q.subject === question.subject)).toBe(false);
        h.context().jev.questions.register(question);
        await h.host.setEnabled('readprobe', false);
        expect(messageQuestions().some((q) => q.subject === question.subject)).toBe(false);
        h.context().jev.questions.register(question)();
        expect(messageQuestions().some((q) => q.subject === question.subject)).toBe(false);
      },
    );
  },
);

describe(
  'message facts memo',
  () => {
    it(
      'scopes memo keys automatically in a registered filter and shares reads across evaluations',
      () => {
        const once = vi.fn(() => undefined);
        const h = start((ctx) => ctx.rules.filter(
          'readprobe.memo',
          {
            test: (_, { facts }) => facts.memo('x', once) === undefined,
          },
        ));
        const m = textMessage(h.db, h.raw.id)!;
        const facts = factsReader(h.db)(m);
        facts.memo('x', () => 'host value');
        const filter = h.kinds.prepareFilter({
          type: 'readprobe.memo',
          config: null,
        });
        expect(filter.test(
          filter.config,
          {
            m,
            facts,
          },
        )).toBe(true);
        expect(filter.test(
          filter.config,
          {
            m,
            facts,
          },
        )).toBe(true);
        expect(once).toHaveBeenCalledTimes(1);
        expect(facts.memo('x', () => 'wrong')).toBe('host value');
      },
    );
    it(
      'reads once per message, caches undefined, and isolates the same key in two plugin contexts',
      () => {
        const h = start(() => undefined);
        const read = factsReader(h.db);
        const m = textMessage(h.db, h.raw.id)!;
        const facts = read(m);
        const once = vi.fn(() => undefined);
        facts.scoped('one').memo('x', once);
        facts.scoped('one').memo('x', once);
        expect(once).toHaveBeenCalledTimes(1);
        facts.scoped('two').memo('x', once);
        read({
          ...m,
          id: 'next',
        }).scoped('one').memo('x', once);
        expect(once).toHaveBeenCalledTimes(3);
      },
    );
  },
);
