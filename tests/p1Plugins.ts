// Fixture plugins standing in for a full build: panels, slots, shortcuts, rule kinds, Jev switches and queries, notices
// and adoptions, anchored on host and each other. Ids are fixtures'.
import { AFTER_MESSAGE, MESSAGE_SEES } from '@plugin-sdk/shared';
import type { PluginDescriptor } from '@shared/bundledTypes';

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
/** A rule kind's editor fields with no configuration. */
const kind = <T extends string>(type: T) => ({ type, label: type, hint: '', create: () => null, validate: () => undefined });
/** Jev switches adopted under their unstamped pre-plugin keys. */
const adoptedAsIs = (...keys: string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, k]));

/** Summaries' role: a primary panel, shortcuts, an action before a host one, a phone section, a template after another plugin's. */
export const digest: PluginDescriptor = {
  manifest: manifest('digest'),
  panels: [{ id: 'summary', title: 'Summary', importance: 'primary', dialog: false, iconPath: '', before: 'chat' }],
  shortcuts: [{ key: 'j', hint: 'Older', after: 'layout' }, { key: 'k', hint: 'Newer', after: 'j' }],
  rules: { actions: [{ ...kind('digest.summarize'), ...AFTER_MESSAGE, before: 'file' }] },
  jev: { features: [{ key: 'keyThemes', default: false }] },
  notices: [{ kind: 'summary', privacyScoped: true, after: 'plugin' }],
  slots: { phoneSections: [{ id: 'summary', before: 'archive' }], ruleTemplates: [{ id: 'digest', after: 'labels.labels' }] },
  adopts: { jevFeatures: adoptedAsIs('keyThemes'), noticeKinds: { summary: 'summary' }, phoneSections: { summary: 'summary' } },
};

/** Alerts' role: a match-phase action before another plugin's, switches after a host one, a phone section after another plugin's. */
export const inbox: PluginDescriptor = {
  manifest: manifest('inbox'),
  panels: [{ id: 'inbox', title: 'Inbox', importance: 'primary', dialog: false, iconPath: '', before: 'chat' }],
  rules: { actions: [{ ...kind('inbox.notify'), ...AFTER_MESSAGE, phase: 'match', history: true, before: 'digest.summarize' }] },
  jev: {
    features: [
      { key: 'urgentToasts', default: false, after: 'topicMeaning' },
      { key: 'dedupeAlerts', default: false, after: 'inbox.urgentToasts' },
    ],
  },
  notices: [{ kind: 'alert', privacyScoped: true, before: 'plugin' }],
  slots: { phoneSections: [{ id: 'inbox', after: 'digest.summary' }] },
  // The phone stored `alerts` before slot ids were stamped; no panel has that id.
  adopts: { jevFeatures: adoptedAsIs('urgentToasts', 'dedupeAlerts'), noticeKinds: { alert: 'alert' }, phoneSections: { alerts: 'inbox' } },
};

/** Tags' role: a kind in every rule section but match, each placed by a host or plugin kind; a message-menu group before Jev's. */
export const labels: PluginDescriptor = {
  manifest: manifest('labels'),
  panels: [{ id: 'labels', title: 'Labels', importance: 'reference', dialog: false, iconPath: '', after: 'chat' }],
  rules: {
    triggers: [{ ...kind('labels.applied'), event: 'message', after: 'message' }],
    filters: [{ ...kind('labels.any'), after: 'linkDomains' }],
    actions: [{ ...kind('labels.apply'), ...AFTER_MESSAGE, after: 'inbox.notify' }],
  },
  jev: { features: [{ key: 'customTags', default: false, after: 'messageClasses' }] },
  slots: { messageMenu: [{ id: 'labels', before: 'jev' }], ruleTemplates: [{ id: 'labels', after: 'links' }] },
  adopts: { jevFeatures: adoptedAsIs('customTags') },
};

/** Stats' role: a dialog panel placed after another plugin's panel. It has a core side (fixtures/p1Plugins/meter/core). */
export const meter: PluginDescriptor = {
  manifest: manifest('meter'),
  panels: [{ id: 'meter', title: 'Meter', importance: 'reference', dialog: true, iconPath: '', after: 'labels' }],
};

/** Plans' role: a per-message Jev query placed after a host query, under its own subject, run by its own switch. */
export const PLANNER_QUERY = 'messages.planner';
export const PLANNER_SUBJECT = 'planner';
/** The query's yes threshold; no test asks it. */
const EVEN_ODDS = 0.5;
export const planner: PluginDescriptor = {
  manifest: manifest('planner'),
  jev: {
    queries: [{
      id: PLANNER_QUERY,
      after: 'messages.tags',
      subject: PLANNER_SUBJECT,
      group: 'Messages',
      label: 'Plans',
      features: ['planDetection'],
      sees: MESSAGE_SEES,
      use: 'decision',
      condition: null,
      perMessage: true,
      defaults: { type: 'noul', question: 'Is `message` a plan?', yes: 'a plan', no: 'not a plan', minProbability: EVEN_ODDS },
    }],
    features: [{ key: 'planDetection', default: false, after: 'messageTags' }],
  },
  adopts: { jevFeatures: adoptedAsIs('planDetection') },
};

/** A posting plugin's role: an unanchored action that acts as the owner on live messages only. */
export const poster: PluginDescriptor = {
  manifest: manifest('poster'),
  rules: { actions: [{ ...kind('poster.post'), ...AFTER_MESSAGE, actsAsYou: true, liveOnly: true }] },
};

/** Transcription's role: a message-menu group after a host group. */
export const voice: PluginDescriptor = {
  manifest: manifest('voice'),
  slots: { messageMenu: [{ id: 'transcribe', after: 'copy' }] },
};

/** Every fixture plugin, in folder order (tests/fixtures/p1Plugins): a full build. */
export const P1_PLUGINS: readonly PluginDescriptor[] = [digest, inbox, labels, meter, planner, poster, voice];
