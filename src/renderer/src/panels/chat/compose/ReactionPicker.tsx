import { Match, Show, Switch, onCleanup, onMount } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById } from '@/state/directory';
import { loadExpressions } from '@/state/expressions';
import { asReaction, closeReactionPicker, react, reactionPicker, reactionTab as tab, setReactionTab as setTab, type ReactionPickerState, type ReactionTab } from '@/state/reactions';
import { inCompanion } from '@/state/ui';
import { coverOf, setOverlayCover } from '@/state/windows';
import { tokenPx } from '@/ui/format';
import { listen, onPointerDownOutside } from '@/ui/listen';
import { ServerEmojiTab, SystemEmojiTab, type EmojiPick } from './EmojiTab';
import picker from './Picker.module.css';
import styles from './ReactionPicker.module.css';

const PICKER_COVER = 'reaction-picker';

/** Discord's reaction picker: the composer picker's Emoji and System tabs, where Add reaction was chosen. Shift keeps it open. */
export function ReactionPicker() {
  return <Show when={reactionPicker()} keyed>{(s) => <PickerAt state={s} />}</Show>;
}

function PickerAt(props: { state: ReactionPickerState }) {
  let root!: HTMLDivElement;
  const guildId = channelById(props.state.message.channelId)?.guildId ?? DM_GUILD_ID;
  const onPick = (pick: EmojiPick, keep: boolean): void => {
    react(props.state.message, asReaction(pick), true);
    if (!keep) closeReactionPicker();
  };

  // At the point it opened (on a phone, along the bottom, as Discord's sheet), pulled inside what shows of the window
  // (on a phone, above the keyboard).
  const place = (): void => {
    const margin = tokenPx('--cp-space-4');
    const vv = window.visualViewport;
    const top = vv?.offsetTop ?? 0;
    const height = vv?.height ?? innerHeight;
    root.style.maxHeight = `${height - 2 * margin}px`;
    const r = root.getBoundingClientRect();
    const x = inCompanion ? 0 : props.state.x;
    const y = inCompanion ? top + height : props.state.y;
    root.style.left = `${Math.max(margin, Math.min(x, innerWidth - r.width - margin))}px`;
    root.style.top = `${Math.max(top + margin, Math.min(y, top + height - r.height - margin))}px`;
    // The live Discord view is drawn above the page: it gets out of the picker's way.
    setOverlayCover(PICKER_COVER, coverOf(root));
  };
  onCleanup(() => setOverlayCover(PICKER_COVER, null));
  onMount(() => {
    loadExpressions(guildId);
    place();
    listen(window, 'resize', place);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    onCleanup(() => {
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    });
  });
  onPointerDownOutside(() => root, () => true, closeReactionPicker);
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeReactionPicker();
  });

  return (
    <div ref={root} class={styles.root} role="dialog" aria-label="Add reaction">
      <div class={picker.tabs}>
        <SegGroup role="radiogroup" ariaLabel="Emoji set" value={tab()} onChange={(v: ReactionTab) => setTab(v)}>
          <SegButton value="emoji" label="Emoji" size="sm" />
          <SegButton value="system" label="System" size="sm" />
        </SegGroup>
      </div>
      <Switch>
        <Match when={tab() === 'emoji'}>
          <ServerEmojiTab guildId={guildId} onPick={onPick} />
        </Match>
        <Match when={tab() === 'system'}>
          <SystemEmojiTab onPick={onPick} />
        </Match>
      </Switch>
    </div>
  );
}
