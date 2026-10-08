// Discord slash commands in the Archive composer: the index Discord serves, and a run as the renderer asks for it.
import type { OwnerFile } from './compose';

/** Discord's application command option types. */
export const OPTION = {
  subcommand: 1,
  group: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11,
} as const;

/** Discord's application command type for a slash command (user and message commands live in context menus). */
export const CHAT_INPUT_COMMAND = 1;

/** Discord's interaction types, as the client posts them. */
export const INTERACTION = { command: 2, component: 3, autocomplete: 4, modalSubmit: 5 } as const;

export interface CommandChoice {
  name: string;
  value: string | number;
}

export interface CommandOption {
  type: number;
  name: string;
  description: string;
  required: boolean;
  choices: CommandChoice[];
  autocomplete: boolean;
  /** A subcommand's or group's own options. */
  options: CommandOption[];
  /** Channel types a channel option accepts; empty = any. */
  channelTypes: number[];
  minValue: number | null;
  maxValue: number | null;
  minLength: number | null;
  maxLength: number | null;
}

export interface CommandApp {
  id: string;
  name: string;
  /** Icon hash, for the app icon on cdn.discordapp.com. */
  icon: string | null;
}

export interface AppCommand {
  id: string;
  applicationId: string;
  version: string;
  name: string;
  description: string;
  options: CommandOption[];
}

/** A server role, for role options and role menus. `color`: 0xRRGGBB, null for none. */
export interface GuildRole {
  id: string;
  name: string;
  color: number | null;
  guildId: string;
}

/** The slash commands the owner can use in one channel: its server's apps, and apps they installed themselves. */
export interface CommandIndex {
  apps: CommandApp[];
  commands: AppCommand[];
}

/** A command the owner ran, as an app's reply names it (`name`: the full name, with any subcommand). */
export interface UsedCommand {
  applicationId: string;
  name: string;
}

/** One line of the `/` menu: a command, or one of its subcommands (`path` = group and subcommand names). */
export interface CommandEntry {
  command: AppCommand;
  path: string[];
  /** "name group sub", as typed after the slash. */
  fullName: string;
  description: string;
  /** The options filled in for this entry. */
  options: CommandOption[];
}

/** Every runnable entry of the commands: subcommands replace their parent, as Discord lists them. */
export function commandEntries(commands: AppCommand[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (command: AppCommand, path: string[], description: string, options: CommandOption[]): void => {
    const nested = options.filter((o) => o.type === OPTION.subcommand || o.type === OPTION.group);
    if (!nested.length) {
      out.push({ command, path, fullName: [command.name, ...path].join(' '), description, options });
      return;
    }
    for (const o of nested) walk(command, [...path, o.name], o.description, o.options);
  };
  for (const c of commands) walk(c, [], c.description, c.options);
  return out;
}

export type OptionValue = string | number | boolean;

/** A command as the owner filled it in; attachment options name a file in `files`. */
export interface CommandRun {
  channelId: string;
  /** null in DMs. */
  guildId: string | null;
  command: { id: string; applicationId: string; version: string; name: string };
  /** Group and subcommand names, as in CommandEntry. */
  path: string[];
  /** Filled options by name, typed as their option. */
  values: { name: string; type: number; value: OptionValue }[];
  /** Files for attachment options, by option name. */
  files: { name: string; file: OwnerFile }[];
}

/** The option being typed, whose suggestions the app is asked for; `values` holds what is filled so far. */
export interface AutocompleteRequest extends Omit<CommandRun, 'files'> {
  focused: { name: string; type: number; value: string };
}

/** A pressed button or a changed select menu on a bot's message. */
export interface ComponentUse {
  channelId: string;
  guildId: string | null;
  messageId: string;
  messageFlags: number;
  applicationId: string;
  componentType: number;
  customId: string;
  /** A select menu's chosen values (ids for user, role, channel and mentionable menus). */
  values?: string[];
}

/** How a bot answered: nothing to do here (its reply arrives as a message), or a form to fill in. */
export type InteractionOutcome = { kind: 'done' } | { kind: 'modal'; modal: BotModal };

/** A field of a bot's pop-up form. `wrap`: how Discord nested it, sent back the same way. */
export type ModalField =
  | {
      kind: 'text';
      wrap: 'row' | 'label';
      customId: string;
      label: string;
      description: string | null;
      paragraph: boolean;
      placeholder: string | null;
      value: string;
      required: boolean;
      minLength: number | null;
      maxLength: number | null;
    }
  | {
      kind: 'select';
      wrap: 'row' | 'label';
      customId: string;
      label: string;
      description: string | null;
      placeholder: string | null;
      required: boolean;
      minValues: number;
      maxValues: number;
      options: { label: string; value: string; description: string | null; selected: boolean }[];
    }
  | { kind: 'info'; content: string };

/** A bot's pop-up form (Discord calls it a modal). */
export interface BotModal {
  /** The interaction id Discord gave the form; the submission names it. */
  id: string;
  applicationId: string;
  appName: string;
  channelId: string;
  guildId: string | null;
  customId: string;
  title: string;
  fields: ModalField[];
}

/** A submitted form: each field's custom id and value (a select's chosen values). */
export interface ModalSubmit {
  modal: BotModal;
  values: Record<string, string | string[]>;
}

/** Discord's /thread: a public thread in a text channel, and the first message in it when one is given. */
export interface NewThread {
  channelId: string;
  name: string;
  /** Empty: the thread starts with no message. */
  message: string;
  /** Only people added to it and moderators can see it (Discord's Private Thread); absent or false: public. */
  private?: boolean;
}

/** Discord's /msg: a direct message to one person, sent from any channel. */
export interface DirectMessage {
  userId: string;
  message: string;
}
