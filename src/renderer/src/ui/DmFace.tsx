import { For, Match, Switch, createSignal } from 'solid-js';
import { avatarUrl, groupIconUrl } from '@shared/media';
import { isGroup, type DmChannel } from '@/state/dmRules';
import { Icon } from './icons';
import styles from './DmFace.module.css';

/** DM faces use group icons or stacked members; one-to-one DMs use peer avatars. Missing images fall back to initials/group marks; small selects avatar-sm. */
export function DmFace(props: { channel: DmChannel; small?: boolean }) {
  const c = () => props.channel;
  const people = () => c().dm.recipients;
  const [iconFailed, setIconFailed] = createSignal(false);
  return (
    <span class={styles.face} data-size={props.small ? 'sm' : undefined} aria-hidden="true">
      <Switch fallback={<span class={styles.initial}>{[...c().name][0] ?? ''}</span>}>
        <Match when={c().icon && !iconFailed() ? c().icon : null}>
          {(icon) => <img class={styles.photo} src={groupIconUrl(c().id, icon())} alt="" loading="lazy" onError={() => setIconFailed(true)} />}
        </Match>
        <Match when={isGroup(c()) && people().length > 1}>
          <span class={styles.stack}>
            <For each={people().slice(0, 2)}>{(p) => <img class={styles.stacked} src={avatarUrl(p.id, p.avatar)} alt="" loading="lazy" />}</For>
          </span>
        </Match>
        <Match when={isGroup(c())}>
          <span class={styles.initial}>
            <Icon name="group" class={styles.groupMark} />
          </span>
        </Match>
        <Match when={people()[0] ?? c().peer}>{(p) => <img class={styles.photo} src={avatarUrl(p().id, p().avatar)} alt="" loading="lazy" />}</Match>
      </Switch>
    </span>
  );
}
