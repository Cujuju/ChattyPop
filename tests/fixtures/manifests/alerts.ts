// Alerts: rule matches, their inbox and notifications, with the original stored identities.
import { defineChannels, definePlugin, definePreference, integersOr } from '@plugin-sdk/shared';
import { aimed, notify, openQuestion, managedMatch } from './rules';
import { ALERT_FEATURES, ALERT_QUERIES } from './queries';
import type { AlertDelivery, AlertItem, AlertQuery } from './types';

/** Core calls shared by the desktop inbox and phone section. */
export interface AlertsCoreCalls {
  /** Alerts newest first, less those privacy mode hides. */
  alerts(query: AlertQuery): AlertItem[];
  /** Marks alerts read: the given ids, or every visible unread one (of these rules when any). */
  markRead(ids: number[] | null, ruleIds?: number[]): void;
  /** Unread counts by rule, restricted to messages privacy mode leaves visible. */
  unread(): Record<number, number>;
}

/** Alert or rule ids as a caller sent them; throws unless every one is an integer. */
function ids(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || !v.every((id) => Number.isSafeInteger(id))) throw new Error(`Not a list of ${what} ids.`);
  return v as number[];
}

/** markRead's arguments checked (the phone makes the call). */
export const decodeMarkRead = ([alertIds, ruleIds]: readonly unknown[]): Parameters<AlertsCoreCalls['markRead']> => [
  alertIds === null ? null : ids(alertIds, 'alert'),
  ruleIds === undefined ? undefined : ids(ruleIds, 'rule'),
];

/** A burst updates the inbox; main delivers only the alerts selected by core, to the devices core chose. */
export interface AlertsEvents {
  changed: null;
  notify: AlertDelivery[];
}

/** Shared declarations retain rule types, query ids and managed-rule identities. */
/** Alerts in time order, or grouped by rule. */
export type AlertSort = 'time' | 'rule';

export const plugin = definePlugin({
  manifest: {
    id: 'alerts',
    name: 'Alerts',
    version: '1.1.0',
    description: 'A rule-driven inbox, unread badges and notifications for messages that need your attention.',
  },
  channels: defineChannels<{
    core: AlertsCoreCalls;
    events: AlertsEvents;
  }>()({
    core: {
      alerts: { audiences: ['renderer', 'phone'], writes: false },
      markRead: { audiences: ['renderer', 'phone'], writes: true, decode: decodeMarkRead },
      unread: { audiences: ['renderer', 'phone'], writes: false },
    },
    events: {
      changed: ['renderer', 'phone'],
      notify: ['main'],
    },
  }),
  panels: [{
    id: 'alerts',
    title: 'Alerts',
    importance: 'primary',
    dialog: false,
    iconPath: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0',
    before: 'chat',
  }],
  managedRules: {
    aimed_at_me: managedMatch('alerts.aimed'),
    open_questions: managedMatch('alerts.openQuestion'),
  },
  rules: {
    match: [aimed, openQuestion],
    actions: [notify],
  },
  jev: {
    queries: ALERT_QUERIES,
    features: ALERT_FEATURES,
  },
  // Core chooses alerts under privacy mode, so one made before it changed is not sent.
  notices: [{ kind: 'alert', privacyScoped: true, before: 'plugin' }],
  archiveRefs: { alerts: { channel: 'channel_id', message: 'message_id' } },
  // The inbox's order and rule filter; the phone's Alerts section sorts and filters as the desktop's inbox does.
  preferences: {
    // 'topic' was saved before topics became rules.
    sort: definePreference<AlertSort>({ default: 'time', normalize: (v) => (v === 'rule' || v === 'topic' ? 'rule' : 'time'), phone: true }),
    /** Rules whose alerts the inbox shows; none = every alert. */
    ruleIds: definePreference<number[]>({ default: [], normalize: integersOr([]), phone: true }),
  },
  slots: {
    topBar: [{ id: 'bell', after: 'privacy' }],
    phoneSections: [{ id: 'inbox', after: 'summaries.summary' }],
    ruleTemplates: [
      { id: 'words', before: 'links' },
      { id: 'subject', after: 'alerts.words' },
      { id: 'jev', after: 'alerts.subject' },
    ],
  },
  adopts: {
    settings: { 'alerts.sort': 'sort', 'alerts.ruleIds': 'ruleIds' },
    tables: { alerts: 'alerts' },
    managedRules: {
      aimed_at_me: 'aimed_at_me',
      open_questions: 'open_questions',
    },
    // Stored switches and phones' notice choices from before Alerts was a plugin.
    jevFeatures: { urgentToasts: 'urgentToasts', aimedAtMe: 'aimedAtMe', unansweredQuestions: 'unansweredQuestions', dedupeAlerts: 'dedupeAlerts' },
    noticeKinds: { alert: 'alert' },
    // The phone's section was `alerts` before slot ids were stamped: a phone may have stored it.
    phoneSections: { alerts: 'inbox' },
  },
});
export default plugin;
