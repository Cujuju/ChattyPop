import { Show } from 'solid-js';
import { look } from '@/theme/look';
import { brandPath } from './brandIcons';
import { GlobeIcon } from './icons';
import styles from './BrandIcon.module.css';

/** A site's filled mark in the text colour, or a line globe for an unknown host. */
export function BrandIcon(props: { domain: string }) {
  return (
    <Show when={brandPath(props.domain)} fallback={<GlobeIcon class={`${styles.mark} ${look.lineIcon}`} />}>
      {(path) => (
        <svg class={`${styles.mark} ${look.brandMark}`} viewBox="0 0 24 24" aria-hidden="true">
          <path d={path()} />
        </svg>
      )}
    </Show>
  );
}
