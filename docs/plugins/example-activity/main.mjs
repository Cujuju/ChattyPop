// Example plugin for the Settings-managed plugin folder; see docs/plugins.md.

/** @param {import('../../../src/shared/plugins').PluginApi} api */
export function activate(api) {
  const counts = api.db.table('counts');
  api.db.migrate([`CREATE TABLE ${counts} (author_id TEXT PRIMARY KEY, messages INTEGER NOT NULL)`]);
  const bump = api.db.prepare(`INSERT INTO ${counts} (author_id, messages) VALUES (?, 1) ON CONFLICT(author_id) DO UPDATE SET messages = messages + 1`);

  api.onMessage((m) => {
    bump.run(m.authorId);
    if (m.content.trim().endsWith('?')) api.annotate(m.id, 'question', 'Asked a question');
  });

  api.commands.register({
    id: 'top-posters',
    title: 'Top posters',
    run(range) {
      const tally = new Map();
      for (const m of api.query.messages({ sinceTs: range.sinceTs, untilTs: range.untilTs, channelIds: range.channelIds ?? undefined })) {
        tally.set(m.authorId, (tally.get(m.authorId) ?? 0) + 1);
      }
      const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3);
      return top.length ? top.map(([id, n]) => `${id}: ${n}`).join(', ') : 'No messages in range.';
    },
  });

  // Called by the Activity panel (panel.mjs) through PanelApi.call.
  api.rpc.handle('topAuthors', () => api.db.prepare(`SELECT author_id AS id, messages FROM ${counts} ORDER BY messages DESC LIMIT 5`).all());

  api.log('activated');
  return () => api.log('deactivated');
}
