// Per-channel slash drafts retain required/added optional pills with typed text and resolved values.
import { api } from '@/api';
import { createStore, produce } from 'solid-js/store';
import { OPTION, type CommandChoice, type CommandEntry, type CommandOption, type CommandRun } from '@shared/commands';
import { followOutcome, interactionGuild } from './commands';
import { typedValue, type FilledOption } from './commandOptions';
import { runLocalCommand, type LocalCommand } from './localCommands';

export type { FilledOption } from './commandOptions';

interface CommandDraft {
  entry: CommandEntry;
  /** Set for /thread and /msg, which ChattyPop runs itself; unset for an app's command. */
  local?: LocalCommand;
  /** Options with a pill in the bar, in order: the required ones, then optional ones as added. */
  shown: string[];
  /** Each pill's text as typed (or the label of what was picked). */
  texts: Record<string, string>;
  values: Record<string, FilledOption>;
  files: Record<string, File>;
  /** Typed at the bar's end, naming an optional option to add; it must be used or cleared before the command runs. */
  tail: string;
}

const [drafts, setDrafts] = createStore<Record<string, CommandDraft | undefined>>({});

export const commandDraft = (channelId: string): CommandDraft | undefined => drafts[channelId];

export function startCommand(channelId: string, entry: CommandEntry, local?: LocalCommand): void {
  setDrafts(channelId, { entry, local, shown: entry.options.filter((o) => o.required).map((o) => o.name), texts: {}, values: {}, files: {}, tail: '' });
}

export function cancelCommand(channelId: string): void {
  setDrafts(channelId, undefined);
}

// Mutates drafts in place; store merges retain omitted keys.
const change = (channelId: string, fn: (d: CommandDraft) => void): void =>
  void setDrafts(channelId, produce((d) => d && fn(d)));

/** Adds an optional option's pill to the bar; the name typed at its end is used up. */
export const addOption = (channelId: string, name: string): void =>
  change(channelId, (d) => {
    if (!d.shown.includes(name) && d.entry.options.some((o) => o.name === name)) d.shown.push(name);
    d.tail = '';
  });

export const setCommandTail = (channelId: string, text: string): void => change(channelId, (d) => void (d.tail = text));

/** Takes an optional option's pill out of the bar, with what was filled in; a required one stays. */
export const removeOption = (channelId: string, name: string): void =>
  change(channelId, (d) => {
    if (d.entry.options.find((o) => o.name === name)?.required !== false) return;
    d.shown = d.shown.filter((n) => n !== name);
    delete d.texts[name];
    delete d.values[name];
    delete d.files[name];
  });

/** A pill's typed text; it is the value when it is a valid one for a text or number option, else the option is unfilled. */
export const setOptionText = (channelId: string, o: CommandOption, text: string): void =>
  change(channelId, (d) => {
    d.texts[o.name] = text;
    const v = typedValue(o, text);
    if (v) d.values[o.name] = v;
    else delete d.values[o.name];
  });

/** A value picked from the list above the bar; the pill shows its label. */
export const pickOption = (channelId: string, name: string, filled: FilledOption): void =>
  change(channelId, (d) => {
    d.values[name] = filled;
    d.texts[name] = filled.label;
  });

export const setOptionFile = (channelId: string, name: string, file: File | null): void =>
  change(channelId, (d) => {
    if (file) d.files[name] = file;
    else delete d.files[name];
  });

const filled = (d: CommandDraft, o: CommandOption): boolean => (o.type === OPTION.attachment ? !!d.files[o.name] : !!d.values[o.name]);

/** Required options still empty. */
export function missingOptions(channelId: string): CommandOption[] {
  const d = drafts[channelId];
  return d ? d.entry.options.filter((o) => o.required && !filled(d, o)) : [];
}

/** Pills with text that isn't a value: not a valid number or length, or not picked from the list. */
export function unfinishedOptions(channelId: string): CommandOption[] {
  const d = drafts[channelId];
  return d ? d.entry.options.filter((o) => d.shown.includes(o.name) && !!d.texts[o.name] && !filled(d, o)) : [];
}

/** Why the bar's end holds text: it names no optional option left to add. Null when it is empty. */
const tailProblem = (d: CommandDraft): string | null => (d.tail.trim() ? `No option to add is named “${d.tail.trim()}”.` : null);

/** Every required option is filled, no pill holds text that isn't a value, and nothing is left typed at the bar's end. */
export const commandReady = (channelId: string): boolean => {
  const d = drafts[channelId];
  return !!d && !missingOptions(channelId).length && !unfinishedOptions(channelId).length && !tailProblem(d);
};

/** Clears the draft that was run, unless it was cancelled and another started meanwhile. */
const finishRun = (channelId: string, d: CommandDraft): void => {
  if (drafts[channelId] === d) cancelCommand(channelId);
};

const runBase = (channelId: string, guildId: string, d: CommandDraft): Omit<CommandRun, 'files'> => ({
  channelId,
  guildId: interactionGuild(guildId),
  command: { id: d.entry.command.id, applicationId: d.entry.command.applicationId, version: d.entry.command.version, name: d.entry.command.name },
  path: d.entry.path,
  values: d.entry.options.flatMap((o) => (o.type !== OPTION.attachment && d.values[o.name] ? [{ name: o.name, type: o.type, value: d.values[o.name]!.value }] : [])),
});

/** Runs the channel's filled-in command; the draft clears once the app acknowledged it (or /thread, /msg went through). */
export async function runCommand(channelId: string, guildId: string): Promise<void> {
  const d = drafts[channelId];
  if (!d) return;
  const blocking = [...missingOptions(channelId), ...unfinishedOptions(channelId)];
  if (blocking.length) throw new Error(`Fill in ${blocking.map((o) => o.name).join(', ')}.`);
  const tail = tailProblem(d);
  if (tail) throw new Error(tail);
  if (d.local) {
    await runLocalCommand(d.local, channelId, Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, v.value])));
    finishRun(channelId, d);
    return;
  }
  const files = await Promise.all(
    Object.entries(d.files).map(async ([name, f]) => ({ name, file: { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } })),
  );
  const outcome = await api.discord.runCommand({ ...runBase(channelId, guildId, d), files });
  finishRun(channelId, d);
  followOutcome(outcome);
}

/** The app's suggestions for an option as typed so far. */
export function suggest(channelId: string, guildId: string, option: CommandOption, typed: string): Promise<CommandChoice[]> {
  const d = drafts[channelId];
  if (!d) return Promise.resolve([]);
  const base = runBase(channelId, guildId, d);
  return api.discord.autocomplete({ ...base, values: base.values.filter((v) => v.name !== option.name), focused: { name: option.name, type: option.type, value: typed } });
}
