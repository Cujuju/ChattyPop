// Summaries: archived recaps, scheduled rules, citations and notifications.
import { defineChannels, definePlugin, definePreference, finiteOr, type AppUsage, type ProviderId } from '@plugin-sdk/shared';
import { summarize } from './rules';
import { SUMMARY_FEATURES, SUMMARY_QUERIES } from './queries';
import { decodeSummaryRequest } from './request';
import type { Summary, SummaryEstimate, SummaryFailure, SummaryPageQuery, SummaryProgress, SummaryPrompts, SummaryRequest, SummarySpend } from './types';
import type { SummaryPromptTemplates } from './prompts';
import { DEFAULT_SUMMARY_SETTINGS, normalizeSummarySettings, type SummaryTrigger } from './settings';

/** Typed calls for desktop, phone and notification delivery. */
export interface SummaryCalls {
  summarize(request: SummaryRequest): Promise<Summary>;
  page(query: SummaryPageQuery): Summary[];
  estimate(request: SummaryRequest): SummaryEstimate | null;
  prompts(own?: SummaryPromptTemplates): SummaryPrompts;
  usageSince(provider: ProviderId, sinceTs: number): AppUsage;
  /** What runs since each time cost, in order. */
  spending(sinceTs: number[]): SummarySpend[];
  notifyAuto(): boolean;
}

/** Run progress and results; main only receives events that may notify. */
export interface SummaryEvents {
  progress: SummaryProgress;
  added: Summary;
  failed: SummaryFailure;
}

/** Stable identities and legacy storage adoption. */

export const plugin = definePlugin({
  coverage: {
    noun: 'summary',
    past: 'summarized',
  },
  aiRuns: {
    singular: 'summary',
    plural: 'summaries',
    active: 'Summarizing',
  },
  storedContent: 'summaries',
  manifest: {
    id: 'summaries',
    name: 'Summaries',
    version: '1.1.0',
    description: 'Cited recaps of archived conversations, on demand or on a schedule.',
  },
  channels: defineChannels<{ core: SummaryCalls; events: SummaryEvents }>()({
    core: {
      // A run stores its summary and spends the owner's AI plan.
      summarize: { audiences: ['renderer', 'phone'], writes: true, decode: decodeSummaryRequest },
      page: { audiences: ['renderer', 'phone'], writes: false },
      estimate: { audiences: ['renderer', 'phone'], writes: false },
      prompts: ['renderer'],
      usageSince: { audiences: ['renderer', 'phone'], writes: false },
      spending: { audiences: ['renderer'], writes: false },
      notifyAuto: ['main'],
    },
    events: {
      progress: ['renderer', 'phone'],
      added: ['renderer', 'phone', 'main'],
      failed: ['renderer', 'phone', 'main'],
    },
  }),
  panels: [{
    id: 'summary',
    title: 'Summary',
    importance: 'primary',
    dialog: false,
    iconPath: 'M11 3.5 12.8 8.2 17.5 10 12.8 11.8 11 16.5 9.2 11.8 4.5 10 9.2 8.2z M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
    after: 'sync-status',
    presets: [{
      id: 'stacked',
      after: 'provider',
      size: 1,
    }, {
      id: 'side-by-side',
      after: 'provider',
      size: 3,
    }, {
      id: 'tabbed',
      before: 'chat',
    }],
  }],
  settings: [{
    id: 'summaries',
    label: 'Summaries',
    tab: {
      after: 'rules',
      iconPath: 'M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9 10h6M9 14h6M9 18h4',
    },
  }],
  shortcuts: [{
    key: 'j',
    hint: 'citations',
    hintGroup: 'citations',
    after: 'layout',
  }, {
    key: 'k',
    hint: 'citations',
    hintGroup: 'citations',
    after: 'j',
  }],
  rules: { actions: [summarize] },
  jev: {
    queries: SUMMARY_QUERIES,
    features: SUMMARY_FEATURES,
  },
  // Core redacts summaries under privacy mode, so one made before it changed is not sent.
  notices: [{ kind: 'summary', privacyScoped: true, after: 'plugin' }],
  archiveRefs: { summaries: { channels: 'channel_ids' } },
  slots: {
    statusBar: [{ id: 'status', after: 'disk' }],
    phoneSections: [{ id: 'summary', before: 'archive' }],
    ruleTemplates: [
      { id: 'digest', after: 'tags.tags' },
      { id: 'catchUp', after: 'summaries.digest' },
    ],
  },
  // The phone's Summary section starts on the owner's range and marks the newest summary seen; not prompts or focus.
  preferences: {
    settings: definePreference({ default: DEFAULT_SUMMARY_SETTINGS, normalize: normalizeSummarySettings, phone: ['defaultRange'] }),
    /** The newest summary seen; null until first stored. */
    seenId: definePreference<number | null>({ default: null, normalize: finiteOr(null), phone: true }),
    /** When the retired schedule last ran the digest, read once into the digest rule. */
    lastDigestAt: definePreference<number | null>({ default: null, normalize: finiteOr(null) }),
    /** Set once the timed rules exist, so a deleted one is never made again. */
    autoMigrated: definePreference({ default: false, normalize: (v: unknown) => v === true }),
  },
  adopts: {
    settingFields: [
      { key: 'legacy.summarySettings', field: 'skipObviousFiller', name: 'settings' },
      { key: 'legacy.summarySettings', field: 'jevRouting', name: 'settings' },
      { key: 'ai', field: 'skipObviousFiller', name: 'settings' },
      { key: 'ai', field: 'jevRouting', name: 'settings' },
    ],
    tables: { summaries: 'summaries' },
    settings: {
      summary: 'settings',
      'summary.seenId': 'seenId',
      'summary.lastDigestAt': 'lastDigestAt',
      'rules.autoSummariesMigrated': 'autoMigrated',
    },
    // Stored switches and phones' notice choices from before Summaries was a plugin.
    jevFeatures: {
      summaryFilter: 'summaryFilter',
      citationCheck: 'citationCheck',
      skipQuietStretches: 'skipQuietStretches',
      conversationChunks: 'conversationChunks',
      keyThemes: 'keyThemes',
      modelRouting: 'modelRouting',
    },
    noticeKinds: { summary: 'summary' },
    // The phone's section was `summary` before slot ids were stamped: a phone may have stored it.
    phoneSections: { summary: 'summary' },
  },
});
export default plugin;
