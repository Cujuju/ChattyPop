import './reportPageErrors';
import './theme/index.css';
// The plugin registry: its stylesheets follow the theme's. Script order is free: the SDK and host modules never import
// it (tests/rendererInit.test.ts).
import './plugins/bundled';
import { startApp } from './boot';
startApp();
