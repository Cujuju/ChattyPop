// Feature vocabulary composes host sentences without loading renderer plugin components.
import { describe, expect, it, vi } from 'vitest';
import { type PluginDescriptor } from '../src/shared/bundledTypes';
import { checkBundled } from '../src/shared/bundledCheck';
import {
  aiRunWording, coverageWording, encryptionHint, orderJevFeatures, optionsNote,
  phoneOverview, themeHints, type JevFeatureGroup,
} from '../src/renderer/src/plugins/featureWording';
import { HOST_JEV_FEATURES } from '../src/shared/aiSettings';
import { bundledJevFeatures } from '@shared/bundledPlugins';
// This build: the fixture plugins, whose switches are placed by host and own switches.
vi.mock('virtual:bundled-plugins/shared', () => import('./p1Registry'));

const coverage = {
  noun: 'summary',
  past: 'summarized',
};
const aiRuns = {
  singular: 'summary',
  plural: 'summaries',
  active: 'Summarizing',
};
const descriptor = (id: string, fields: Partial<PluginDescriptor> = {}): PluginDescriptor => ({
  manifest: {
      id,
      name: id,
      version: '1',
      description: '',
    },
  ...fields,
});

describe('coverage wording', () => {
  it('preserves all summary retention and window sentences', () => {
    expect(coverageWording(coverage)).toEqual({
      option: 'Compress, then remove summarized text',
      meta: 'summarized text removed',
      short: 'Remove text once summarized',
      hint: 'Removed text keeps its author, time and attachments, so summary citations still open it. Text no summary covers is never removed.',
      cap: 'Over the limit, the oldest messages are compressed first, then (with the summary tier) their summarized text is removed.',
      pending: 'the rest is not yet covered by a summary.',
      tier: 'removing text needs the summary tier above.',
      covered: 'a summary covers it',
      window: 'Since you were last here, after what a summary already covers; at most a week',
    });
  });

  it('uses generic coverage wording when its owner is absent', () => {
    expect(coverageWording()).toEqual({
      option: 'Compress, then remove covered text',
      meta: 'covered text removed',
      short: 'Remove text once covered',
      hint: 'Removed text keeps its author, time and attachments. Text without coverage from an active plugin is never removed.',
      cap: 'Over the limit, the oldest messages are compressed first, then their text is removed if the tier and an active coverage provider allow it.',
      pending: 'the rest is not yet covered by an active plugin.',
      tier: 'removing text needs the coverage tier above.',
      covered: 'an active plugin covers it',
      window: 'Since you were last here, after already covered time; at most a week',
    });
  });
});

describe('AI run wording', () => {
  it('preserves summary prose', () => {
    expect(aiRunWording(aiRuns)).toEqual({
      singular: 'summary',
      plural: 'summaries',
      provider: 'Summarizing provider',
      title: "Only ChattyPop's own summaries in this window. The percentage is your whole plan, including other apps.",
      empty: 'No summaries yet',
      overview: 'Turn providers on and pick the model each one uses. Each feature chooses its provider in its own settings.',
      requests: 'summaries',
    });
  });

  it('uses generic AI prose with its owner off', () => {
    expect(aiRunWording()).toEqual({
      singular: 'AI run',
      plural: 'AI runs',
      provider: 'AI provider',
      title: "Only ChattyPop's own AI runs in this window. The percentage is your whole plan, including other apps.",
      empty: 'No AI runs yet',
      overview: 'Turn providers on and pick the model each one uses. Each feature chooses its provider in its own settings.',
      requests: 'requests',
    });
  });
});

describe('rule and phone overviews', () => {
  it('preserves the default summaries and alerts phone sentence', () => {
    expect(phoneOverview([{
      noun: 'summaries',
      does: 'run a summary',
    }, { noun: 'alerts' }])).toBe(
      'Read summaries, alerts and the archive on your phone, run a summary, and post from the Archive.',
    );
  });

  it('handles an absent owner, no owners, and multiple action sections', () => {
    // How the phone reaches this PC is the transport's sentence, appended by its settings page.
    const tail = ' post from the Archive.';
    expect(phoneOverview([{ noun: 'alerts' }])).toBe(`Read alerts and the archive on your phone, and${tail}`);
    expect(phoneOverview([])).toBe(`Read the archive on your phone, and${tail}`);
    expect(phoneOverview([{
      noun: 'recaps',
      does: 'request a recap',
    }, {
      noun: 'notes',
      does: 'save notes',
    }])).toBe(
      `Read recaps, notes and the archive on your phone, request a recap and save notes, and${tail}`,
    );
  });
});

describe('theme and encryption wording', () => {
  it('uses primary and reference titles in input order, ignoring secondary panels', () => {
    expect(themeHints([
      {
        title: 'Summary',
        importance: 'primary',
      }, {
        title: 'Alerts',
        importance: 'primary',
      },
      {
        title: 'Plan usage',
        importance: 'reference',
      }, {
        title: 'Chat',
        importance: 'reference',
      },
      {
        title: 'Tags',
        importance: 'reference',
      }, {
        title: 'Links',
        importance: 'secondary',
      },
    ])).toEqual({
      spotlight: 'Graphite with a mint accent, IBM Plex type. Summary and Alerts are lit; Plan usage, Chat and Tags dim.',
      tide: 'Soft slate, rounded spaced cards, Atkinson Hyperlegible type. Summary and Alerts lift; reference panels recede.',
    });
  });

  it('uses singular grammar with one panel and generic descriptions with no active titles', () => {
    expect(themeHints([{
      title: 'Notes',
      importance: 'primary',
    }, {
      title: 'Archive',
      importance: 'reference',
    }])).toEqual({
      spotlight: 'Graphite with a mint accent, IBM Plex type. Notes is lit; Archive dims.',
      tide: 'Soft slate, rounded spaced cards, Atkinson Hyperlegible type. Notes lifts; reference panels recede.',
    });
    expect(themeHints([])).toEqual({
      spotlight: 'Graphite with a mint accent, IBM Plex type. Primary panels are lit; reference panels dim.',
      tide: 'Soft slate, rounded spaced cards, Atkinson Hyperlegible type. Primary panels lift; reference panels recede.',
    });
  });

  it('joins every active stored-content noun and keeps the attachment caveat', () => {
    const tail = ' are encrypted on disk; the key is protected by your Windows sign-in, so only this Windows account can open the archive. Attachment files are not encrypted.';
    expect(encryptionHint(['summaries'])).toBe(`Messages, summaries and settings${tail}`);
    expect(encryptionHint(['summaries', 'notes'])).toBe(`Messages, summaries, notes and settings${tail}`);
    expect(encryptionHint([])).toBe(`Messages and settings${tail}`);
  });
});

describe('query wording and feature groups', () => {
  it('uses per-query runtime guidance or the generic explanation', () => {
    const note = 'The options are the themes named for each summary, so only the question and threshold can change.';
    expect(optionsNote({ optionsNote: note })).toBe(note);
    const otherNote = 'The options are the destinations enabled for this export.';
    expect(optionsNote({ optionsNote: otherNote })).toBe(otherNote);
    expect(optionsNote({ optionsNote: note })).toBe(note);
    expect(optionsNote({})).toBe('The options come from the run, so only the question and threshold can change.');
  });

  it('orders Jev switches by host order and declared placement, grouped in the host group order', () => {
    const groups: Record<string, JevFeatureGroup> = { h1: 'Tools', h2: 'Alerts', 'p.a': 'Alerts', 'p.b': 'Alerts', 'p.c': 'Tools', 'q.z': 'Summaries' };
    const plugins = [{ key: 'q.z' }, { key: 'p.a', anchor: { before: 'h2' } }, { key: 'p.b', anchor: 'p.a' }, { key: 'p.c' }];
    expect(orderJevFeatures(['h1', 'h2'], plugins, (k) => groups[k])).toEqual(['p.a', 'p.b', 'h2', 'q.z', 'h1', 'p.c']);
    // A switch with no row (its plugin off, or a managed rule's) drops out; its placement still counts.
    expect(orderJevFeatures(['h1', 'h2'], plugins, (k) => (k === 'p.a' ? undefined : groups[k]))).toEqual(['p.b', 'h2', 'q.z', 'h1', 'p.c']);
  });

  it('keeps the Settings → Jev order the build’s declared placements give, in the host group order', () => {
    // The expected rows and groups; switches without an anchor follow the host's.
    const before: [string, JevFeatureGroup][] = [
      ['topicMeaning', 'Alerts'], ['inbox.urgentToasts', 'Alerts'], ['inbox.dedupeAlerts', 'Alerts'], ['catchUpBadges', 'Alerts'], ['ruleQuestions', 'Alerts'],
      ['digest.keyThemes', 'Summaries'], ['keepImportant', 'Messages & search'], ['messageTags', 'Messages & search'],
      ['planner.planDetection', 'Messages & search'], ['messageClasses', 'Messages & search'], ['labels.customTags', 'Messages & search'],
      ['suggestChannels', 'Tools'], ['pluginDecide', 'Tools'], ['messageCheck', 'Tools'],
    ];
    const groups = new Map(before);
    expect(orderJevFeatures(HOST_JEV_FEATURES, bundledJevFeatures(), (k) => groups.get(k))).toEqual(before.map(([k]) => k));
  });

  it('refuses a Jev switch placed by another plugin’s switch or by an unknown one', () => {
    const placed = (after: string) => descriptor('probe', { jev: { features: [{ key: 'a', default: false }, { key: 'b', default: false, after }] } });
    expect(() => checkBundled([placed('probe.a')])).not.toThrow();
    expect(() => checkBundled([placed('topicMeaning')])).not.toThrow();
    expect(() => checkBundled([placed('other.a')])).toThrow(/placed by other.a, not a host switch or its own/);
    expect(() => checkBundled([placed('nowhere')])).toThrow(/placed by nowhere/);
  });
});

describe('singleton feature ownership', () => {
  it('accepts one coverage or AI owner and rejects two distinct declarers', () => {
    expect(() => checkBundled([descriptor('one', {
      coverage,
      aiRuns,
    })])).not.toThrow();
    expect(() => checkBundled([descriptor('one', { coverage }), descriptor('two', { coverage })])).toThrow(/coverage provider/);
    expect(() => checkBundled([descriptor('one', { aiRuns }), descriptor('two', { aiRuns })])).toThrow(/AI run provider/);
  });
});
