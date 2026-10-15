import './theme/index.css';
// The plugin registry: its stylesheets follow the theme's. Script order is free: the SDK and host modules never import
// it (tests/rendererInit.test.ts).
import './plugins/bundled';
import { startApp } from './boot';
import { api } from './api';
import { errorReporter } from '@plugin-sdk/renderer/errorReporter';

errorReporter(window, () => performance.now(), (report) => Promise.resolve(api.reportPageError(report)), crypto.randomUUID());
startApp();
