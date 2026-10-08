import { render } from 'solid-js/web';
import '../../src/renderer/src/theme/index.css';
document.documentElement.dataset.surface = new URL(location.href).searchParams.get('mobile') === '1' ? 'companion' : 'desktop';
window.reviewErrors = [];
window.addEventListener('error', e => window.reviewErrors.push(e.message));
window.addEventListener('unhandledrejection', e => window.reviewErrors.push(String(e.reason)));


const pluginDir = new URL(location.href).searchParams.get('plugin');
if (!pluginDir) throw new Error('Pass the summaries plugin directory in ?plugin=<absolute path>.');
const { SummaryControls } = await import(/* @vite-ignore */ `/@fs/${pluginDir}/renderer/SummaryControls.tsx`);
const { mutateDirectory } = await import('/src/state/directory.ts');
const { DM_GUILD_ID } = await import('../../src/shared/discord.ts');
mutateDirectory([
  { id: 'review-guild', name: 'Review server', icon: null, channels: Array.from({length: 50}, (_, i) => ({id: 'review-channel-' + i, guildId: 'review-guild', name: i === 0 ? 'general' : 'channel-' + i, type: 0, optedIn: true})) },
  { id: DM_GUILD_ID, name: 'Direct messages', channels: Array.from({length: 4}, (_, i) => ({id: 'review-dm-' + i, guildId: DM_GUILD_ID, name: 'Review person ' + i, type: 1, optedIn: true})) }
]);
window.reviewDispose = render(SummaryControls, document.getElementById('root'));
