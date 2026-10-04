// Host-owned privacy views over declared plugin archive references.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { pluginTableName } from '@shared/bundledTypes';
import { checkArchiveRefs, visibleTableName } from '@shared/archiveRefs';
import type { Db } from '../db';
import { visibleChannelSql, visibleMessageRefSql } from '../queries/privacy';
import { migratePlugin } from './api';

/** Rebuilds declared views after adoption or migration; optional tables may await their first plugin migration. */
export function createArchiveRefViews(db: Db, plugin: PluginDescriptor, required = true): void {
  checkArchiveRefs(plugin);
  for (const [name, ref] of Object.entries(plugin.archiveRefs ?? {})) {
    const table = pluginTableName(plugin.manifest.id, name);
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[];
    if (!exists || !columns.length || !Object.values(ref).every((column) => columns.includes(column!))) {
      if (required) throw new Error(`${plugin.manifest.id} archive reference ${name}: missing table or declared column`);
      continue;
    }
    const column = (field: string): string => `r."${field}"`;
    const visible = ref.channels !== undefined
      ? `(json_array_length(${column(ref.channels)}) = 0 OR EXISTS (SELECT 1 FROM json_each(${column(ref.channels)}) c WHERE ${visibleChannelSql('c.value')}))`
      : ref.message !== undefined
        ? visibleMessageRefSql(column(ref.channel), column(ref.message))
        : visibleChannelSql(column(ref.channel));
    const view = visibleTableName(plugin, name);
    db.exec(`DROP VIEW IF EXISTS "${view}"; CREATE VIEW "${view}" AS SELECT r.* FROM "${table}" r WHERE ${visible}`);
  }
}

/** Migrates owned tables and rebuilds their visibility views atomically, including table-replacement migrations. */
export function migrateArchiveRefs(db: Db, plugin: PluginDescriptor, steps: readonly string[]): void {
  checkArchiveRefs(plugin);
  db.transaction(() => {
    for (const name of Object.keys(plugin.archiveRefs ?? {})) db.exec(`DROP VIEW IF EXISTS "${visibleTableName(plugin, name)}"`);
    migratePlugin(db, plugin.manifest.id, steps);
    createArchiveRefViews(db, plugin);
  })();
}
