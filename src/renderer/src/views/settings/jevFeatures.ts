// Descriptions and controls for Jev feature switches.
import type { Component } from 'solid-js';
import { bundledJevFeatures } from '@shared/bundledPlugins';
import { isHostJevFeature, type HostJevFeature, type JevFeature } from '@shared/settings';
import type { JevFeatureGroup } from '../../plugins/featureWording';

/** A Settings → Jev row's wording: what the toggle does, and how many questions it adds per new message (cost). */
export interface JevFeatureView {
  Body?: Component;
  group: JevFeatureGroup;
  hint: string;
  perMessage?: string;
}
/** A row as Settings shows it: a plugin's switch is named by its declaration (`label`), the host's here. */
export interface JevFeatureInfo extends JevFeatureView {
  label: string;
}
const PLUGIN_LABELS = new Map<string, string>(bundledJevFeatures().map((f) => [f.key, f.label]));
/** A switch's name, whether or not its plugin is on; its stored key when no installed plugin declares it. */
export const jevFeatureLabel = (f: JevFeature): string => (isHostJevFeature(f) ? JEV_FEATURE_INFO[f].label : PLUGIN_LABELS.get(f) ?? f);

/** The host's own switches' rows; a plugin's come from its renderer contribution (`jevFeatures`). */
export const JEV_FEATURE_INFO: Readonly<Record<HostJevFeature, JevFeatureInfo>> = {
  topicMeaning: {
    group: 'Alerts',
    label: 'Rules by meaning',
    hint: 'A rule can match messages about a subject you describe, not just its keywords. Sends each new message in such a rule’s scope.',
    perMessage: '1 question per message for each rule by meaning',
  },
  ruleQuestions: {
    group: 'Alerts',
    label: 'Rules with your own Jev question',
    hint: 'A rule can ask Jev your own yes/no, pick-one or 0–N score question about each message in its scope, and act on the answers you choose.',
    perMessage: '1 question per message for each such rule',
  },
  catchUpBadges: {
    group: 'Alerts',
    label: 'Catch-up badges on channels',
    hint: 'Jev marks notable messages; each channel shows how many arrived since you last opened it.',
    perMessage: '1 question per message (shared with keep-important)',
  },
  keepImportant: {
    group: 'Messages & search',
    label: 'Keep notable messages when trimming text',
    hint: 'Text retention keeps messages Jev marked notable verbatim.',
    perMessage: '1 question per message (shared with catch-up badges)',
  },
  messageTags: { group: 'Messages & search', label: 'Tag messages', hint: 'Jev tags messages as a question, announcement, plan, decision…', perMessage: '1 question per message' },
  messageClasses: {
    group: 'Messages & search',
    label: 'Political, finance and trading labels',
    hint: 'Jev labels each new message political, finance or trading (any, all or none).',
    perMessage: '3 questions per message',
  },
  messageCheck: {
    group: 'Tools',
    label: 'Right-click Jev check',
    hint: 'Right-click a message to run Jev checks on it, or ask your own question. Sends only that message, only when you ask.',
  },
  suggestChannels: { group: 'Tools', label: 'Suggest channels to archive', hint: 'Samples channels you don’t archive and ranks them against your rules.' },
  pluginDecide: { group: 'Tools', label: 'Let plugins ask Jev', hint: 'Plugins may call ai.decide(); it bills to your Jev key.' },
};
