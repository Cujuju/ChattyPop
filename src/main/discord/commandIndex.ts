// The slash commands usable in a channel, from the indexes Discord's own client reads.
import { CHAT_INPUT_COMMAND, type AppCommand, type CommandApp, type CommandIndex, type CommandOption } from '@shared/commands';
import type { DiscordReader } from './client';
import type { GatewayTap } from './gatewayTap';

interface RawOption {
  type: number;
  name: string;
  name_default?: string;
  description?: string;
  description_default?: string;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  autocomplete?: boolean;
  options?: RawOption[];
  channel_types?: number[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
}

interface RawCommand extends RawOption {
  id: string;
  application_id: string;
  version: string;
  /** Where a user-installed command may run: 0 servers, 1 the app's DM, 2 other DMs and group DMs. */
  contexts?: number[] | null;
}

interface RawIndex {
  applications?: { id: string; name: string; icon?: string | null }[];
  application_commands?: RawCommand[];
}

/** Discord's interaction contexts, as a command's `contexts` lists them. */
const CONTEXT = { guild: 0, botDm: 1, privateChannel: 2 } as const;

// Commands run under their untranslated names; Discord sends a localized copy alongside.
const toOption = (o: RawOption): CommandOption => ({
  type: o.type,
  name: o.name_default ?? o.name,
  description: o.description_default ?? o.description ?? '',
  required: o.required === true,
  choices: o.choices ?? [],
  autocomplete: o.autocomplete === true,
  options: (o.options ?? []).map(toOption),
  channelTypes: o.channel_types ?? [],
  minValue: o.min_value ?? null,
  maxValue: o.max_value ?? null,
  minLength: o.min_length ?? null,
  maxLength: o.max_length ?? null,
});

const toCommand = (c: RawCommand): AppCommand => {
  const { name, description, options } = toOption(c);
  return { id: c.id, applicationId: c.application_id, version: c.version, name, description, options };
};

/** Caches server, DM and installed-app slash commands. Gateway command-change notices invalidate server scopes. */
export class CommandIndexes {
  private readonly cache = new Map<string, Promise<RawIndex>>();

  /** Subscribe before the client opens its socket (as the tap requires). */
  constructor(tap: GatewayTap) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'READY') this.cache.clear();
      else if (t === 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE') this.cache.delete(`guild:${(d as { guild_id: string }).guild_id}`);
    });
  }

  /** The commands usable in a channel: `guildId` null for a DM. */
  async forChannel(api: DiscordReader, channelId: string, guildId: string | null): Promise<CommandIndex> {
    const scope = guildId ? this.load(api, `guild:${guildId}`, `guilds/${guildId}/application-command-index`) : this.load(api, `dm:${channelId}`, `channels/${channelId}/application-command-index`);
    const [local, own] = await Promise.all([scope, this.load(api, 'user', 'users/@me/application-command-index')]);
    const allowed = guildId ? [CONTEXT.guild] : [CONTEXT.botDm, CONTEXT.privateChannel];
    const ownHere = (own.application_commands ?? []).filter((c) => !c.contexts || c.contexts.some((x) => (allowed as number[]).includes(x)));
    const commands = new Map<string, AppCommand>();
    for (const c of [...(local.application_commands ?? []), ...ownHere]) if (c.type === CHAT_INPUT_COMMAND && !commands.has(c.id)) commands.set(c.id, toCommand(c));
    const apps = new Map<string, CommandApp>();
    for (const a of [...(local.applications ?? []), ...(own.applications ?? [])]) apps.set(a.id, { id: a.id, name: a.name, icon: a.icon ?? null });
    return { apps: [...apps.values()], commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  private load(api: DiscordReader, key: string, path: string): Promise<RawIndex> {
    let index = this.cache.get(key);
    if (!index) {
      index = api.get<RawIndex>(path);
      this.cache.set(key, index);
      index.catch(() => this.cache.delete(key)); // try again next time
    }
    return index;
  }
}
