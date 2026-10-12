// Real components with synthetic account data; this fixture never contacts Discord.
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import { setMediaRoot } from '../../src/shared/media';
import '../../src/renderer/src/theme/index.css';

// Local illustration: the browser fixture does not have Electron's cached-media protocol.
const avatar = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#384966"/><circle cx="20" cy="15" r="8" fill="#b8d6ea"/><path d="M5 40v-5a15 15 0 0 1 30 0v5" fill="#b8d6ea"/></svg>';
setMediaRoot('/unused-fixture-media/', { avatar: `data:image/svg+xml,${encodeURIComponent(avatar)}#` });

window.reviewErrors = [];
window.addEventListener('error', (e) => window.reviewErrors.push(e.message));
window.addEventListener('unhandledrejection', (e) => window.reviewErrors.push(String(e.reason)));
const originalFetch = window.fetch.bind(window);
window.fetch = (url, options) => String(url) === 'chattypop-installed://index.json'
  ? Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
  : originalFetch(url, options);
const listeners = [], calls = [];
const CHANNEL = '100000000000000001', BOOKMARK = '200000000000000001', REMINDER = '200000000000000002', AUTHOR = '300000000000000001', GUILD = '400000000000000001', CATEGORY = '100000000000000002';
let session = 'fixture', revision = 1, locked = false, failRead = false, indexReadFailed = false;
const row = (messageId, dueAt, summary) => ({ channelId: CHANNEL, messageId, guildId: GUILD, savedAt: '2026-10-01T12:00:00Z', dueAt,
  authorName: 'Sample author', author: { id: AUTHOR, avatar: 'a'.repeat(32) }, channelName: '#planning', summary, available: messageId === BOOKMARK });
let records = [row(BOOKMARK, null, 'Keep the project checklist handy.'), row(REMINDER, '2090-10-12T16:00:00Z', 'Review the launch checklist.')];
const emit = (e) => listeners.forEach((fn) => fn(e));
const changed = (reset = false) => emit({ type: 'saved-messages-changed', session, revision: ++revision, pageEpoch: 0, reset });
const defaultCall = async () => [];
const group = (methods) => new Proxy(methods, { get: (target, key) => target[key] ?? defaultCall });
const plugins = () => [{ id: 'discord-client', key: 'discord-client', name: 'Discord client', bundled: true, status: locked ? 'disabled' : 'active', commands: [] }];
window.chattypop = {
  core: group({ plugins: async () => plugins(), getSetting: async () => undefined,
    directory: async () => [{ id: GUILD, name: 'Project team', icon: null, channels: [
      { id: CATEGORY, guildId: GUILD, name: 'Text Channels', kind: 4, parentId: null, optedIn: false, position: 0, messageCount: 0 },
      { id: CHANNEL, guildId: GUILD, name: 'planning', kind: 0, parentId: CATEGORY, optedIn: true, position: 1, messageCount: 2 },
    ] }], messageById: async () => null }),
  discord: group({
    savedMessages: async (refresh) => {
      calls.push(['index', refresh]); if (failRead) throw new Error('Discord returned 404 while loading saved messages. The cause is not confirmed. Use Refresh to retry.');
      const current = indexReadFailed ? [] : records;
      return { session, revision, pageEpoch: 0, writableChannelIds: [CHANNEL], reminders: current.filter((m) => m.dueAt), bookmarkIds: current.filter((m) => !m.dueAt).map((m) => m.messageId), ...(indexReadFailed ? { indexReadFailed: true } : {}) };
    },
    savedBookmarks: async (request) => { calls.push(['page', request]); return { session, revision, pageEpoch: 0, bookmarks: indexReadFailed ? [] : records.filter((m) => !m.dueAt), hasMore: false, nextBefore: null }; },
    saveMessage: async (input) => {
      calls.push(['save', input]); if (locked || input.session !== session || input.revision !== revision) throw new Error('Saved messages changed. Refresh to try again.');
      records = records.map((m) => m.messageId === input.messageId ? { ...m, dueAt: input.dueAt ?? null } : m); changed();
    },
    removeSavedMessage: async (input) => {
      calls.push(['remove', input]); if (locked || input.session !== session || input.revision !== revision) throw new Error('Saved messages changed. Refresh to try again.');
      records = records.filter((m) => m.messageId !== input.messageId); changed();
    },
  }),
  plugins: group({}), media: group({}), desktop: group({}), rules: group({}), storage: group({}),
  openPanelWindow: defaultCall, setUnsaved: defaultCall,
  onEvent: (fn) => { listeners.push(fn); return () => {}; },
};

const [{ BookmarksPanel }, { ReminderDialog }, saved, { postingUnlocked }, { firstPaintReady }] = await Promise.all([
  import('../../src/renderer/src/panels/bookmarks/index.tsx'),
  import('../../src/renderer/src/views/reminder/ReminderDialog.tsx'),
  import('../../src/renderer/src/state/savedMessages.ts'),
  import('../../src/renderer/src/state/posting.ts'),
  import('../../src/plugin-sdk/renderer/firstPaint.ts'),
]);
await firstPaintReady();
document.documentElement.dataset.theme = 'spotlight';
render(() => [createComponent(BookmarksPanel, {}), createComponent(ReminderDialog, {})], document.getElementById('root'));
window.savedFixture = {
  saved, calls, postingUnlocked,
  lock: (value) => { locked = value; emit({ type: 'plugins-changed' }); },
  failure: (value) => { failRead = value; return saved.refreshSavedMessages(); },
  readFailure: (value) => { indexReadFailed = value; return saved.refreshSavedMessages(); },
  privacy: () => emit({ type: 'privacy-changed' }),
  remoteChange: () => changed(),
  newSession: () => { session = 'fixture-new'; revision = 0; changed(true); },
};
