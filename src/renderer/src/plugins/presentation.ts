// Reactive host presentation assembled from active feature declarations.
import { BUNDLED_PLUGINS, bundledPanel, panelAnchor } from '@shared/bundledPlugins';
import { placeByAnchor } from '@shared/anchors';
import { activeBundledPanels } from './slots';
import { pluginActive } from '../state/plugins';
import { PANEL_TITLES, panelImportance, type PanelId } from '../panels/titles';
import { aiRunWording, coverageWording, encryptionHint, themeHints } from './featureWording';

const active = () => BUNDLED_PLUGINS.filter((plugin) => pluginActive(plugin.manifest.id));

/** Active retention vocabulary, or generic coverage wording. */
export const coverageText = () => coverageWording(active().find((plugin) => plugin.coverage)?.coverage);

/** Active AI vocabulary. */
export const aiText = () => aiRunWording(active().find((plugin) => plugin.aiRuns)?.aiRuns);

/** Active owners add their stored nouns to the host's encryption description. */
export const encryptionText = () => encryptionHint(active().flatMap((plugin) => plugin.storedContent ?? []));

/** Active panel titles and importance determine theme descriptions. */
export function appearanceText() {
  const ids = placeByAnchor<string>(Object.keys(PANEL_TITLES), activeBundledPanels().map((panel) => panel.id), (id) => id, panelAnchor);
  return themeHints(ids.map((id) => ({
    title: bundledPanel(id)?.title ?? PANEL_TITLES[id as PanelId],
    importance: panelImportance(id),
  })));
}
