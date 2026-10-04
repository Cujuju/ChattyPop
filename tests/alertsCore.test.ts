// The host meaning-query override migration, and rule reloads that leave the archive unread.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jevQueryDef } from '@shared/jevQueries';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting } from '../src/core/db';
import { loadJevQueryOverrides } from '../src/core/jevQueryHandlers';
import { jevQuery, setJevQueryOverrides } from '../src/core/jev/queries';
import { probeAction, ruleHarness, ruleInput } from './ruleHarness';
import { tempDb } from './helpers';

afterEach(() => setJevQueryOverrides({}));

describe('host meaning query migration', () => {
  const edited = {
    ...jevQueryDef('rules.meaning')!.defaults,
    question: 'Does `message` concern `topic`?',
  };

  it('moves an edited legacy query once and uses it for the host meaning match', () => {
    const db = tempDb();
    setSetting(db, SETTINGS_KEYS.jevQueries, { 'alerts.topicMeaning': edited });
    loadJevQueryOverrides(db);
    expect(getSetting(db, SETTINGS_KEYS.jevQueries)).toEqual({ 'rules.meaning': edited });
    expect(jevQuery('rules.meaning')).toEqual(edited);
    loadJevQueryOverrides(db);
    expect(getSetting(db, SETTINGS_KEYS.jevQueries)).toEqual({ 'rules.meaning': edited });
  });

  it('keeps an existing new-id override when both keys were stored', () => {
    const db = tempDb();
    const newer = { ...edited, question: 'Does `message` directly discuss `topic`?' };
    setSetting(db, SETTINGS_KEYS.jevQueries, {
      'alerts.topicMeaning': edited,
      'rules.meaning': newer,
    });
    loadJevQueryOverrides(db);
    expect(getSetting(db, SETTINGS_KEYS.jevQueries)).toEqual({ 'rules.meaning': newer });
    expect(jevQuery('rules.meaning')).toEqual(newer);
  });
});

describe('rule reload', () => {
  it('recompiles unchanged rules without reading archive history', () => {
    const h = ruleHarness();
    h.say('news');
    h.rules.create(ruleInput([probeAction()], { match: { text: { pattern: 'news', spec: null } } }));
    const examined = vi.spyOn(h.engine, 'facts');
    h.engine.reload();
    expect(examined).not.toHaveBeenCalled();
  });
});
