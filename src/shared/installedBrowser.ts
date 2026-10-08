// Pure installed-browser contract provides accepted-plugin indexes and browser paths. Main serves files; desktop/phone consume them.

/** Desktop windows: `chattypop-installed://<INSTALLED_INDEX>` and `chattypop-installed://<plugin id>/<file in browser/>`. */
export const INSTALLED_SCHEME = 'chattypop-installed';
/** The phone page, from the Companion's server: `/installed/<INSTALLED_INDEX>` and `/installed/<plugin id>/<file>`. */
export const INSTALLED_PHONE_PATH = '/installed/';
/** The accepted plugins' manifests (InstalledManifest[]) in load order. Has a dot, so it never names a plugin id (PLUGIN_ID_PATTERN). */
export const INSTALLED_INDEX = 'index.json';

/** Types a plugin's browser/ folder may serve, by extension; any other file there is refused. */
export const INSTALLED_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * The host's page for installed plugins' pages, at the renderer root: its head (the host's page bootstrap) goes into
 * each installed page main serves (docs/plugin-architecture.md §16, Pages).
 */
export const INSTALLED_PAGE_SHELL = 'installed-page.html';
/** The meta naming an installed page's entry module (its URL), which the host's page bootstrap imports last. */
export const INSTALLED_PAGE_ENTRY_META = 'chattypop-page-entry';
/** The sessionStorage key where installed page `pageId` keeps its shown section; the loader loads that section's plugins first. */
export const pageSectionKey = (pageId: string): string => `${pageId}.tab`;
