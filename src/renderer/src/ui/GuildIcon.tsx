import { Show, createSignal } from 'solid-js';
import { guildIconUrl } from '@shared/media';
import styles from './GuildIcon.module.css';

const INITIALS_MAX = 2;

/** Server avatar: cached icon, or initials when the server has none or it fails to load. */
export function GuildIcon(props: { id: string; name: string; icon: string | null }) {
  const [failed, setFailed] = createSignal(false);
  const initials = () =>
    props.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, INITIALS_MAX)
      .map((w) => [...w][0])
      .join('');
  return (
    <Show when={props.icon && !failed()} fallback={<span class={styles.initials} aria-hidden="true">{initials()}</span>}>
      <img class={styles.icon} src={guildIconUrl(props.id, props.icon!)} alt="" onError={() => setFailed(true)} />
    </Show>
  );
}
