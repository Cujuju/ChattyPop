// Trigger-maintained privacy scope avoids per-read channel traversal. Frozen migration: append changes instead of editing.

/** Privacy mode is on (settings key 'privacyMode' holds JSON true), read when a trigger runs. */
const ON = `(SELECT value FROM settings WHERE key = 'privacyMode') = 'true'`;

/** Adds the channels matching `where` (over alias c) that are hidden: marked, or under a marked parent or server. */
const addChannels = (where: string): string => `
    INSERT OR IGNORE INTO hidden_ids (kind, id)
      SELECT 'channel', c.id FROM channels c LEFT JOIN channels p ON p.id = c.parent_id LEFT JOIN guilds g ON g.id = c.guild_id
      WHERE (${where}) AND ${ON} AND (c.hide_in_privacy = 1 OR p.hide_in_privacy = 1 OR g.hide_in_privacy = 1);`;

/** Rebuilds matching channel scope and removes gone ids using separate keyed deletes. */
const refreshChannels = (where: string, gone?: string): string => `${gone ? `
    DELETE FROM hidden_ids WHERE kind = 'channel' AND id IN (${gone});` : ''}
    DELETE FROM hidden_ids WHERE kind = 'channel' AND id IN (SELECT c.id FROM channels c WHERE ${where});${addChannels(where)}`;

/** Re-derives server `ids`' own entries. */
const refreshServers = (ids: string): string => `
    DELETE FROM hidden_ids WHERE kind = 'server' AND id IN (${ids});
    INSERT OR IGNORE INTO hidden_ids (kind, id) SELECT 'server', id FROM guilds WHERE id IN (${ids}) AND hide_in_privacy = 1 AND ${ON};`;

/** Everything again: privacy mode turned on or off. */
const REFRESH_ALL = `
    DELETE FROM hidden_ids;
    INSERT OR IGNORE INTO hidden_ids (kind, id) SELECT 'server', id FROM guilds WHERE hide_in_privacy = 1 AND ${ON};${addChannels('1')}`;

/** A row's id or flag changed while the old or new row is marked: rows under it (children, a server's channels) change. */
const markChanged = `(OLD.hide_in_privacy = 1 OR NEW.hide_in_privacy = 1) AND (OLD.id IS NOT NEW.id OR OLD.hide_in_privacy IS NOT NEW.hide_in_privacy)`;

export const HIDDEN_SCOPE_TABLE = `
  DROP VIEW hidden_ids;
  DROP VIEW hidden_channels;
  -- Privacy-hidden channel/server snowflakes; empty when privacy mode is off. Channels inherit hidden marks from parents and servers.
  --
  CREATE TABLE hidden_ids (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (kind, id)) WITHOUT ROWID;
  CREATE VIEW hidden_channels AS SELECT id FROM hidden_ids WHERE kind = 'channel';
  -- Triggers rebuild affected scope while privacy mode is on. Mark changes affect descendants; inserts handle REPLACE, which skips delete triggers.
  --
  --
  --
  --
  CREATE INDEX channels_parent ON channels (parent_id);
  CREATE INDEX channels_guild ON channels (guild_id);
  CREATE TRIGGER hidden_scope_setting_ai AFTER INSERT ON settings WHEN NEW.key = 'privacyMode' BEGIN${REFRESH_ALL}
  END;
  CREATE TRIGGER hidden_scope_setting_au AFTER UPDATE ON settings WHEN OLD.key = 'privacyMode' OR NEW.key = 'privacyMode' BEGIN${REFRESH_ALL}
  END;
  CREATE TRIGGER hidden_scope_setting_ad AFTER DELETE ON settings WHEN OLD.key = 'privacyMode' BEGIN${REFRESH_ALL}
  END;
  CREATE TRIGGER hidden_scope_channel_ai AFTER INSERT ON channels WHEN ${ON} BEGIN${refreshChannels('c.id = NEW.id', 'NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_channel_children_ai AFTER INSERT ON channels WHEN ${ON} BEGIN${refreshChannels('c.parent_id = NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_channel_au AFTER UPDATE OF id, parent_id, guild_id, hide_in_privacy ON channels
    WHEN ${ON} AND (OLD.id IS NOT NEW.id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.guild_id IS NOT NEW.guild_id
      OR OLD.hide_in_privacy IS NOT NEW.hide_in_privacy) BEGIN${refreshChannels('c.id IN (OLD.id, NEW.id)', 'OLD.id, NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_channel_children_au AFTER UPDATE OF id, hide_in_privacy ON channels WHEN ${ON} AND ${markChanged} BEGIN${refreshChannels('c.parent_id IN (OLD.id, NEW.id)')}
  END;
  CREATE TRIGGER hidden_scope_channel_ad AFTER DELETE ON channels WHEN ${ON} BEGIN
    DELETE FROM hidden_ids WHERE kind = 'channel' AND id = OLD.id;
  END;
  CREATE TRIGGER hidden_scope_channel_children_ad AFTER DELETE ON channels WHEN ${ON} AND OLD.hide_in_privacy = 1 BEGIN${refreshChannels('c.parent_id = OLD.id')}
  END;
  CREATE TRIGGER hidden_scope_guild_ai AFTER INSERT ON guilds WHEN ${ON} BEGIN${refreshServers('NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_guild_channels_ai AFTER INSERT ON guilds WHEN ${ON} BEGIN${refreshChannels('c.guild_id = NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_guild_au AFTER UPDATE OF id, hide_in_privacy ON guilds
    WHEN ${ON} AND (OLD.id IS NOT NEW.id OR OLD.hide_in_privacy IS NOT NEW.hide_in_privacy) BEGIN${refreshServers('OLD.id, NEW.id')}
  END;
  CREATE TRIGGER hidden_scope_guild_channels_au AFTER UPDATE OF id, hide_in_privacy ON guilds WHEN ${ON} AND ${markChanged} BEGIN${refreshChannels('c.guild_id IN (OLD.id, NEW.id)')}
  END;
  CREATE TRIGGER hidden_scope_guild_ad AFTER DELETE ON guilds WHEN ${ON} BEGIN${refreshServers('OLD.id')}
  END;
  CREATE TRIGGER hidden_scope_guild_channels_ad AFTER DELETE ON guilds WHEN ${ON} AND OLD.hide_in_privacy = 1 BEGIN${refreshChannels('c.guild_id = OLD.id')}
  END;
  ${REFRESH_ALL}
`;

/** A renamed row takes the place of any row it replaced, whose mark may differ: its dependents re-derive on any id change. */
const idOrMarkChanged = `(OLD.id IS NOT NEW.id OR OLD.hide_in_privacy IS NOT NEW.hide_in_privacy)`;

/** Frozen fix for UPDATE OR REPLACE deleting marked rows without delete triggers. Rebuilds dependent scope after replacement. */
export const HIDDEN_SCOPE_RENAMES = `
  DROP TRIGGER hidden_scope_channel_children_au;
  DROP TRIGGER hidden_scope_guild_channels_au;
  CREATE TRIGGER hidden_scope_channel_children_au AFTER UPDATE OF id, hide_in_privacy ON channels WHEN ${ON} AND ${idOrMarkChanged} BEGIN${refreshChannels('c.parent_id IN (OLD.id, NEW.id)')}
  END;
  CREATE TRIGGER hidden_scope_guild_channels_au AFTER UPDATE OF id, hide_in_privacy ON guilds WHEN ${ON} AND ${idOrMarkChanged} BEGIN${refreshChannels('c.guild_id IN (OLD.id, NEW.id)')}
  END;
  ${REFRESH_ALL}
`;
