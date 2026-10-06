// Plugin API 1.1 renderer entry renders into a plain element without the host framework.

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
