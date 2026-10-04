import { defineCorePlugin } from '@plugin-sdk/core';
import plugin from '../shared';
import { greeting } from '../shared/greeting';

export default defineCorePlugin(plugin, (ctx) => ctx.channels.serve({ greet: (name) => greeting(name) }));
