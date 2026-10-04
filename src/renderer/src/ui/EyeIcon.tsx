import { Icon } from './icons';

/** Privacy mode's eye; `crossed` strikes it through (hidden). Size and colour come from `class`. */
export function EyeIcon(props: { class?: string; crossed?: boolean }) {
  return <Icon name={props.crossed ? 'eyeOff' : 'eye'} class={props.class} />;
}