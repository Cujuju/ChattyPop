// Reaches the SDK through its contract and kit tiers only, as a plugin's renderer side does.
import { defineRendererPlugin } from '@plugin-sdk/renderer';
import { look } from '@plugin-sdk/renderer/kit';
import plugin from '../shared';
import styles from './Panel.module.css';

/** Structure from its module, look from the theme's vocabulary. */
export const Row = (props: { text: string }) => <p class={`${styles.row} ${look.text}`} data-tone="muted">{props.text}</p>;

export default defineRendererPlugin(plugin, {});
