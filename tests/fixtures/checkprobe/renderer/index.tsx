import { defineRendererPlugin } from '@plugin-sdk/renderer';
import { look } from '@plugin-sdk/renderer/kit';
import plugin from '../shared';
import { greeting } from '../shared/greeting';
import styles from './Greeting.module.css';

/** Structure from its module, look from the theme's vocabulary. */
export const Greeting = (props: { name: string }) => <p class={`${styles.line} ${look.text}`} data-tone="muted">{greeting(props.name)}</p>;

export default defineRendererPlugin(plugin, {});
