// Real covers, Markdown, embed cards and context menu, with a fixture-only persisted settings transport.
import { createComponent, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import '../../src/renderer/src/theme/index.css';

window.reviewErrors = [];
window.addEventListener('error', event => window.reviewErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.reviewErrors.push(String(event.reason)));
const listeners = [];
const fetchOriginal = window.fetch.bind(window);
window.fetch = (url, options) => String(url) === 'chattypop-installed://index.json'
  ? Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
  : fetchOriginal(url, options);
const prefix = 'chattypop.localSpoilerFixture.';
const defaultCall = async () => [];
const group = overrides => new Proxy(overrides, { get: (target, key) => target[key] ?? defaultCall });
window.chattypop = {
  core: group({
    getSetting: async key => JSON.parse(localStorage.getItem(prefix + key) ?? 'null') ?? undefined,
    setSetting: async (key, value) => {
      localStorage.setItem(prefix + key, JSON.stringify(value));
      listeners.forEach(listener => listener({ type: 'setting-changed', key, value }));
    },
  }),
  discord: group({}), plugins: group({}), windows: group({}), media: group({}),
  onEvent: listener => { listeners.push(listener); return () => {}; },
};

const [{ AttachmentTile }, { Embeds }, { Markdown }, { SpoilerMessage, SpoilersShown }, { senderSpoilerLinks }, { openMessageMenu }, { ContextMenu }, state, { firstPaintReady }] = await Promise.all([
  import('../../src/renderer/src/panels/chat/AttachmentTile.tsx'),
  import('../../src/renderer/src/panels/chat/MessageExtras.tsx'),
  import('../../src/renderer/src/ui/Markdown.tsx'),
  import('../../src/renderer/src/ui/spoilers.ts'),
  import('../../src/renderer/src/ui/mdParse.ts'),
  import('../../src/renderer/src/state/messageActions.ts'),
  import('../../src/renderer/src/ui/ContextMenu.tsx'),
  import('../../src/renderer/src/state/localSpoilers.ts'),
  import('../../src/plugin-sdk/renderer/firstPaint.ts'),
]);
await firstPaintReady();
const { installRendererPlugins } = await import('../../src/renderer/src/plugins/installed.ts');
installRendererPlugins([]);
const attachment = (id, filename, spoiler = false) => ({ id, filename, spoiler, removed: false, status: 'pending', notes: [], sha256: null });
const message = {
  id: 'fixture-message', channelId: 'fixture-channel', content: '[Short link](https://example.com/preview) and ||https://example.com/sender||',
  author: { id: 'other', name: 'Another person' }, notes: [], embeds: [],
  attachments: [attachment('fixture-image', 'picture.png'), attachment('fixture-video', 'video.mp4'), attachment('fixture-native', 'SPOILER_picture.png', true)],
};
const [showSenderSpoilers, setShowSenderSpoilers] = createSignal(true);
window.spoilerFixture = { state, message, setShowSenderSpoilers, reset: async () => {
  for (const key of JSON.parse(localStorage.getItem(prefix + 'chat.localSpoilers') ?? '[]')) await state.setLocalSpoiler(key, false);
} };

function section(id, content) {
  const element = document.createElement('section');
  element.id = id;
  element.oncontextmenu = event => openMessageMenu(event, message);
  render(content, element);
  return element;
}
function media(isVideo) {
  const element = document.createElement(isVideo ? 'video' : 'button');
  if (isVideo) { element.controls = true; element.width = 300; element.height = 150; }
  else {
    const image = document.createElement('img');
    image.width = 300; image.height = 150; image.alt = 'Fixture picture';
    image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="teal"/><text x="20" y="80" fill="white">Picture fixture</text></svg>');
    element.append(image);
  }
  return element;
}
const embed = {
  type: 'rich', url: 'https://example.com/preview', title: 'Preview title', description: 'The link preview content.',
  color: null, provider: 'Example', author: null, thumbnailUrl: null, thumbnailSize: null,
  imageUrl: null, imageSize: null, videoUrl: null, videoSize: null, footer: null,
};
render(() => createComponent(SpoilersShown.Provider, {
  value: showSenderSpoilers, // Local covers must override Show spoiler content = Always.
  get children() { return createComponent(SpoilerMessage.Provider, {
    value: () => ({ id: message.id, senderLinks: senderSpoilerLinks(message.content) }),
    get children() { return [
      ...message.attachments.map((file, index) => section(file.id, () => createComponent(AttachmentTile, { attachment: file, children: media(index === 1) }))),
      section('fixture-links', () => createComponent(Markdown, { text: message.content })),
      section('fixture-embed', () => createComponent(Embeds, { embeds: [embed], mentions: {} })),
      createComponent(ContextMenu, {}),
    ]; },
  }); },
}), document.getElementById('root'));
window.reviewReady = true;
