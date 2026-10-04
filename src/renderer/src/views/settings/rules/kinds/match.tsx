// Keyword and Jev match editors and summaries.
import { Show } from 'solid-js';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import type { TextConfig } from '@shared/ruleKinds/host';
import type { ContentKind } from '@shared/messageContent';
import type { HostJevFeature } from '@shared/settings';
import { aiSettings } from '@/state/preferences';
import { conditionWording, JevQuestionField } from '@/ui/JevQuestionField';
import { JEV_FEATURE_INFO } from '@/views/settings/jevFeatures';
import { PatternBuilder } from '../PatternBuilder';
import type { KindProps, KindView } from './types';
import styles from '../Rules.module.css';

const JEV_WORDING = conditionWording('Match', 'Jev question', 'e.g. Does `message` announce a sale?');
/** Names the Settings → Jev switch a match needs while it is off. */
function NeedsSwitch(props: { feature: HostJevFeature }) {
  return (
    <Show when={!aiSettings().jev[props.feature]}>
      <p class="cp-note">Turn on “{JEV_FEATURE_INFO[props.feature].label}” in Settings → Jev to use it.</p>
    </Show>
  );
}
function TextEditor(props: KindProps<TextConfig | undefined>) {
  return (
    <Show
      when={props.config}
      fallback={
        <button type="button" class={styles.addChip} onClick={() => props.onChange({ pattern: '', spec: null })}>
          + Words or phrases
        </button>
      }
    >
      {(text) => (
        <>
          <PatternBuilder
            value={text()}
            onChange={props.onChange}
            channelIds={props.spec?.gates.channelIds ?? null}
            contains={
              (props.spec?.narrow.find((p) => p.type === 'contains')?.config as ContentKind[] | undefined) ?? null
            }
          />
          <button type="button" class={styles.quietButton} onClick={() => props.onChange(undefined)}>
            Remove keywords
          </button>
        </>
      )}
    </Show>
  );
}
function MeaningEditor(props: KindProps<string | undefined>) {
  return (
    <>
      <textarea
        id={props.id}
        class={styles.textarea}
        rows={2}
        placeholder="e.g. a keyboard group buy opening or closing"
        value={props.config ?? ''}
        onInput={(e) => props.onChange(e.currentTarget.value.trim() ? e.currentTarget.value : undefined)}
      />
      <Show when={props.config}>
        <NeedsSwitch feature="topicMeaning" />
      </Show>
    </>
  );
}
function JevEditor(props: KindProps<CustomJevQuestion | undefined>) {
  return (
    <>
      <JevQuestionField
        value={props.config ?? null}
        wording={JEV_WORDING}
        legendHidden
        onChange={(q) => props.onChange(q ?? undefined)}
      />
      <Show when={props.config}>
        <NeedsSwitch feature="ruleQuestions" />
      </Show>
    </>
  );
}
const view = <C,>(v: KindView<C>): KindView => v as KindView;
/** Editors and summaries for direct, meaning, custom Jev and managed alert matches. */
export const matchViews: Record<string, KindView> = {
  text: view({ Editor: TextEditor, summary: () => 'keywords' }),
  meaning: view({
    label: () => (
      <>
        By meaning <span class={styles.jevTag}>Jev</span>
      </>
    ),
    Editor: MeaningEditor,
    summary: () => 'meaning (Jev)',
  }),
  jev: view({ Editor: JevEditor, summary: () => 'Jev question' }),
};
