// Discord's built-in commands that act rather than rewrite the text (/thread, /msg): filled in like an app's command,
// then run by ChattyPop through the client's session instead of reaching an app.
import { api } from '@/api';
import { OPTION, type CommandEntry, type CommandOption, type OptionValue } from '@shared/commands';
import { DISCORD_TEXT_MAX, GUILD_TEXT_CHANNEL_TYPE, THREAD_NAME_MAX } from '@shared/discord';

export type LocalCommand = 'thread' | 'msg';

const option = (type: number, name: string, description: string, required: boolean, maxLength: number | null): CommandOption => ({
  type,
  name,
  description,
  required,
  choices: [],
  autocomplete: false,
  options: [],
  channelTypes: [],
  minValue: null,
  maxValue: null,
  minLength: null,
  maxLength,
});

/** A menu entry in the shape an app's command has, so the same form fills it in; it has no app, id or version. */
const entry = (name: string, description: string, options: CommandOption[]): CommandEntry => ({
  command: { id: '', applicationId: '', version: '', name, description, options },
  path: [],
  fullName: name,
  description,
  options,
});

export interface LocalCommandSpec {
  local: LocalCommand;
  entry: CommandEntry;
  /** Whether it can run in a channel of this Discord type (undefined: not in the directory). */
  availableIn: (channelKind: number | undefined) => boolean;
}

export const LOCAL_COMMANDS: LocalCommandSpec[] = [
  {
    local: 'thread',
    entry: entry('thread', 'Starts a new thread.', [
      option(OPTION.string, 'name', 'Name of the thread', true, THREAD_NAME_MAX),
      option(OPTION.string, 'message', 'First message in the thread', false, DISCORD_TEXT_MAX),
    ]),
    // Threads start in plain text channels; not in DMs, forums or other threads.
    availableIn: (kind) => kind === GUILD_TEXT_CHANNEL_TYPE,
  },
  {
    local: 'msg',
    entry: entry('msg', 'Sends a direct message to a user.', [
      option(OPTION.user, 'user', 'The person to message', true, null),
      option(OPTION.string, 'message', 'The message', true, DISCORD_TEXT_MAX),
    ]),
    availableIn: () => true,
  },
];

/** Runs a filled-in /thread or /msg from `channelId`. */
export function runLocalCommand(local: LocalCommand, channelId: string, values: Record<string, OptionValue | undefined>): Promise<void> {
  const text = (name: string): string => (typeof values[name] === 'string' ? (values[name] as string) : '');
  return local === 'thread'
    ? api.discord.createThread({ channelId, name: text('name'), message: text('message') })
    : api.discord.sendDirect({ userId: text('user'), message: text('message') });
}
