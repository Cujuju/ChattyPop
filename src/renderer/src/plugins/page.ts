// A plugin page's host bootstrap (docs/plugin-architecture.md §3, plugin page): the build loads it before the page's own
// entry (pagesPlugin), as main.tsx loads the app's: the theme, then the plugin registry, whose stylesheets follow it.
import '../theme/index.css';
import './bundled';
