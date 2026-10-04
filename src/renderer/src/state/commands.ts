// Slash commands in the Archive composer: the `/` menu, the command being filled in, bot forms, and bot message buttons and menus.
import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import { BUILTIN_COMMANDS, type BuiltinCommand } from '@shared/compose';
import { commandEntries, type BotModal, type CommandApp, type CommandEntry, type InteractionOutcome } from '@shared/commands';
import type { SelectKind } from '@shared/components';
import type { ArchiveMessage, PersonMatch } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById, directory } from './directory';
import { LOCAL_COMMANDS, type LocalCommand } from './localCommands';
import { closeWhenLocked, postingUnlocked } from './posting';
import { composerCommands } from '@/plugins/slots';

/** A guild id as interactions name it: null in a DM. */
export const interactionGuild = (guildId: string): string | null => (guildId === DM_GUILD_ID || !guildId ? null : guildId);

// ---- The `/` menu ----

/**
 * A line of the `/` menu: an app's command; ChattyPop's own (typed as its prefix, answered by ChattyPop); or Discord's
 * built-ins, which rewrite the text (/shrug) or are filled in and run here (/thread, /msg).
 */
export type MenuItem =
  | { kind: 'app'; entry: CommandEntry; app: CommandApp | null }
  | { kind: 'own'; prefix: string; description: string }
  | { kind: 'builtin'; command: BuiltinCommand }
  | { kind: 'local'; local: LocalCommand; entry: CommandEntry };


const [indexKey, setIndexKey] = createSignal<{ channelId: string; guildId: string } | null>(null);
// Tagged with its channel: while another channel's list loads, `latest` still holds the last one.
const [commandIndex, { refetch: refetchIndex }] = createResource(indexKey, async (k) => ({
  channelId: k.channelId,
  ...(await api.discord.commands(k.channelId, interactionGuild(k.guildId))),
}));

/** Frequently used commands shown atop the menu, as many as Discord's own menu shows. */
const FREQUENT_COMMANDS_MAX = 5;
const [frequent, { refetch: refetchFrequent }] = createResource(() => api.core.ownCommands(FREQUENT_COMMANDS_MAX), { initialValue: [] });

/** Loads the channel's commands for the menu; asks again each time, so apps added since show up. */
export function openCommandMenu(channelId: string, guildId: string): void {
  void refetchFrequent();
  const k = indexKey();
  if (k?.channelId === channelId) void refetchIndex();
  else setIndexKey({ channelId, guildId });
}

/** True while the menu's commands load. */
export const commandsLoading = (): boolean => commandIndex.loading;
/** Why the channel's commands couldn't be listed; null when they were. */
export const commandsError = (): string | null => (commandIndex.error ? String((commandIndex.error as Error).message ?? commandIndex.error) : null);

const NAME_WORD_BREAK = /[ _-]/;
/** A name matches when it, or one of its words, starts with what was typed, as in Discord's menu. */
const matches = (name: string, q: string): boolean => name.startsWith(q) || name.split(NAME_WORD_BREAK).some((w) => w.startsWith(q));

/** A group of the menu, with its mark in the menu's side rail: frequently used, ChattyPop's own, or one app's. */
export interface MenuSection {
  id: string;
  title: string;
  mark: { kind: 'frequent' } | { kind: 'own' } | { kind: 'builtin' } | { kind: 'app'; app: CommandApp | null };
  items: MenuItem[];
}

const builtinName = (i: MenuItem): string => (i.kind === 'builtin' ? i.command.name : i.kind === 'local' ? i.entry.fullName : '');

/** ChattyPop's own commands carry its name where apps carry theirs. */
export const OWN_APP_NAME = 'ChattyPop';
/** Discord's own commands (/shrug, /thread…), which the client runs itself: Discord's name for their group. */
export const BUILTIN_GROUP_NAME = 'Built-In';

/**
 * The menu for what follows the slash: frequently used first (before anything is typed), then ChattyPop's own commands,
 * then each app's, apps by name, then Discord's built-ins. Within a group, names starting with what was typed come first, as Discord orders them.
 */
export function menuSections(channelId: string, typed: string): MenuSection[] {
  const q = typed.trim().toLowerCase();
  const own: MenuItem[] = composerCommands()
    .filter((c) => matches(c.prefix, q) || matches(c.name, q))
    .map((c) => ({ kind: 'own', prefix: c.prefix, description: c.description }));
  const sections: MenuSection[] = [];
  const index = !commandIndex.error && commandIndex.latest?.channelId === channelId ? commandIndex.latest : undefined;
  const apps = new Map((index?.apps ?? []).map((a) => [a.id, a]));
  const entries = index ? commandEntries(index.commands).filter((e) => matches(e.fullName.toLowerCase(), q)) : [];
  entries.sort((a, b) => Number(!a.fullName.startsWith(q)) - Number(!b.fullName.startsWith(q)) || a.fullName.localeCompare(b.fullName));
  const item = (entry: CommandEntry): MenuItem => ({ kind: 'app', entry, app: apps.get(entry.command.applicationId) ?? null });
  if (!q) {
    // A failed count (e.g. an older core) just leaves the group out.
    const used = (frequent.error ? [] : frequent.latest).flatMap((u) => entries.find((e) => e.command.applicationId === u.applicationId && e.fullName === u.name) ?? []);
    if (used.length) sections.push({ id: 'frequent', title: 'Frequently Used', mark: { kind: 'frequent' }, items: used.map(item) });
  }
  if (own.length) sections.push({ id: 'own', title: OWN_APP_NAME, mark: { kind: 'own' }, items: own });
  const byApp = new Map<string, CommandEntry[]>();
  for (const e of entries) byApp.set(e.command.applicationId, [...(byApp.get(e.command.applicationId) ?? []), e]);
  const appSections = [...byApp].map(([appId, list]): MenuSection => {
    const app = apps.get(appId) ?? null;
    return { id: appId, title: app?.name ?? 'App', mark: { kind: 'app', app }, items: list.map(item) };
  });
  const kind = channelById(channelId)?.kind;
  const builtins: MenuItem[] = [
    ...BUILTIN_COMMANDS.filter((b) => matches(b.name, q)).map((command): MenuItem => ({ kind: 'builtin', command })),
    ...LOCAL_COMMANDS.filter((l) => l.availableIn(kind) && matches(l.entry.fullName, q)).map((l): MenuItem => ({ kind: 'local', local: l.local, entry: l.entry })),
  ].sort((a, b) => builtinName(a).localeCompare(builtinName(b)));
  const builtinSection: MenuSection[] = builtins.length ? [{ id: 'builtin', title: BUILTIN_GROUP_NAME, mark: { kind: 'builtin' }, items: builtins }] : [];
  return [...sections, ...appSections.sort((a, b) => a.title.localeCompare(b.title)), ...builtinSection];
}

// ---- Bot forms ----

const [modal, setModal] = createSignal<BotModal | null>(null);
/** The bot form open now; null when none is. */
export const botModal = modal;
export const closeBotModal = (): void => void setModal(null);
closeWhenLocked(() => modal() !== null, closeBotModal);

/** Opens the app's form when its answer is one, else closes any; none opens while posting is locked. */
export const followOutcome = (o: InteractionOutcome): void => void setModal(o.kind === 'modal' && postingUnlocked() ? o.modal : null);

export async function submitBotModal(values: Record<string, string | string[]>): Promise<void> {
  const m = modal();
  if (!m) return;
  followOutcome(await api.discord.submitModal({ modal: m, values }));
}

// ---- Buttons and menus on bot messages ----

/** Presses a button (no `values`) or picks from a menu on a bot's message. */
/** Messages with a button or menu press on its way. Held here, not in the row: a row the log re-creates stays busy. */
const [pendingComponents, setPendingComponents] = createSignal<ReadonlySet<string>>(new Set());
export const componentPending = (messageId: string): boolean => pendingComponents().has(messageId);

export async function useMessageComponent(m: ArchiveMessage, componentType: number, customId: string, values?: string[]): Promise<void> {
  if (!m.applicationId) throw new Error('This message has no app to answer.');
  if (componentPending(m.id)) return;
  const guildId = channelById(m.channelId)?.guildId ?? DM_GUILD_ID;
  setPendingComponents((s) => new Set(s).add(m.id));
  try {
    followOutcome(
      await api.discord.useComponent({
        channelId: m.channelId,
        guildId: interactionGuild(guildId),
        messageId: m.id,
        messageFlags: m.flags,
        applicationId: m.applicationId,
        componentType,
        customId,
        ...(values ? { values } : {}),
      }),
    );
  } finally {
    setPendingComponents((s) => {
      const next = new Set(s);
      next.delete(m.id);
      return next;
    });
  }
}

// ---- People, roles and channels for pickers ----

/** A pickable person, role or channel: the id sent, and what is shown. */
export interface EntityChoice {
  id: string;
  label: string;
  hint: string | null;
  kind: 'user' | 'role' | 'channel';
}

/** Rows a picker shows; typing narrows it. */
const PICKER_RESULTS_MAX = 25;

const roleCache = new Map<string, ReturnType<typeof api.discord.roles>>();
const rolesOf = (guildId: string): ReturnType<typeof api.discord.roles> => {
  let r = roleCache.get(guildId);
  if (!r) {
    r = api.discord.roles(guildId);
    roleCache.set(guildId, r);
    r.catch(() => roleCache.delete(guildId));
  }
  return r;
};

const person = (p: PersonMatch): EntityChoice => ({ id: p.id, label: p.name, hint: p.username, kind: 'user' });

/**
 * People (those the archive knows), roles and channels of a server matching `query`, for a user, role, mentionable or
 * channel option or menu. `channelTypes` narrows channels; empty = any.
 */
export async function searchEntities(kind: Exclude<SelectKind, 'string'>, guildId: string, query: string, channelTypes: number[] = []): Promise<EntityChoice[]> {
  const q = query.trim().toLowerCase();
  const out: EntityChoice[] = [];
  if ((kind === 'user' || kind === 'mentionable') && q) out.push(...(await api.core.findPeople(q, PICKER_RESULTS_MAX)).map(person));
  const guild = interactionGuild(guildId);
  if ((kind === 'role' || kind === 'mentionable') && guild) {
    const roles = await rolesOf(guild);
    out.push(...roles.filter((r) => r.name.toLowerCase().includes(q)).map((r) => ({ id: r.id, label: `@${r.name}`, hint: null, kind: 'role' as const })));
  }
  if (kind === 'channel') {
    const channels = directory().find((g) => g.id === guildId)?.channels ?? [];
    out.push(
      ...channels
        .filter((c) => (!channelTypes.length || channelTypes.includes(c.kind)) && c.name.toLowerCase().includes(q))
        .map((c) => ({ id: c.id, label: `#${c.name}`, hint: null, kind: 'channel' as const })),
    );
  }
  return out.slice(0, PICKER_RESULTS_MAX);
}
