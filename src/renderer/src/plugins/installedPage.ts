// An installed plugin's page bootstrap (docs/plugin-architecture.md §16, Pages): loads the page's entry, named by the
// meta main adds, once the registry has published the host modules its shims read.
import { INSTALLED_PAGE_ENTRY_META } from '@shared/installedBrowser';
import './page';

const entry = document.querySelector<HTMLMetaElement>(`meta[name="${INSTALLED_PAGE_ENTRY_META}"]`)?.content;
if (!entry) throw new Error(`An installed plugin's page names no entry (meta ${INSTALLED_PAGE_ENTRY_META}).`);
await import(/* @vite-ignore */ entry);
