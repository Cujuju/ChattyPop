// The p1 fixture plugins as this build's shared registry: vi.mock('virtual:bundled-plugins/shared', () => import('./p1Registry')).
import { P1_PLUGINS } from './p1Plugins';

export default P1_PLUGINS;
/** A complete build: no plugin folder left out, so no catalog of left-out plugins. */
export const catalog = null;
