// Renderer entry (plugin API 1.1): panels render into a plain element with their own code; no host framework is shared.

/** @type {import('../../../src/renderer/src/plugins/types').PluginPanel[]} */
export const panels = [
  {
    id: 'activity',
    title: 'Activity',
    mount(el, api) {
      const list = document.createElement('ol');
      el.append(list);
      const render = async () => {
        const rows = await api.call('topAuthors');
        list.replaceChildren(...rows.map((r) => Object.assign(document.createElement('li'), { textContent: `${r.id}: ${r.messages} messages` })));
      };
      void render();
      const off = api.onArchiveChanged(() => void render());
      return () => off();
    },
  },
];
