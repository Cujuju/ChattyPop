// Posts slash commands, autocomplete, component interactions and forms as the client does. Matches gateway results by nonce after HTTP 204.
import {
  INTERACTION,
  OPTION,
  type AutocompleteRequest,
  type BotModal,
  type CommandChoice,
  type CommandRun,
  type ComponentUse,
  type InteractionOutcome,
  type ModalSubmit,
} from '@shared/commands';
import type { OwnerFile } from '@shared/compose';
import { modalFieldsFrom, modalSubmission } from '@shared/components';
import { DISCORD_UPLOAD_BYTES_MAX, newNonce, snowflakeArg } from '@shared/discord';
import { MS_PER_S } from '@shared/units';
import type { OwnerAccount } from './account';
import type { DiscordClient } from './client';
import type { GatewayTap } from './gatewayTap';
import { uploadFiles } from './send';

/** Discord's client gives up on an app's acknowledgement after this long; so does ChattyPop. */
const ACK_TIMEOUT_MS = 10 * MS_PER_S;
/** Apps get 3 s to suggest; the rest covers the round trips. */
const AUTOCOMPLETE_TIMEOUT_MS = 5 * MS_PER_S;
/** Longest name or custom id Discord accepts for a command, option or component. */
const ID_TEXT_MAX = 100;
/** Longest value the renderer may send for one option or form field (Discord's text input maximum). */
const VALUE_TEXT_MAX = 4000;

type Settle = { resolve: (v: unknown) => void; reject: (e: Error) => void };
interface Pending extends Settle {
  kind: 'run' | 'autocomplete';
  context: { applicationId: string; channelId: string; guildId: string | null };
  timer?: ReturnType<typeof setTimeout>;
}

interface RawModal {
  id: string;
  nonce?: string;
  channel_id: string;
  custom_id: string;
  title: string;
  components: unknown;
  application?: { id: string; name: string };
}


const text = (v: unknown, what: string, max = ID_TEXT_MAX): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Not a ${what}.`);
  return v;
};
const guildArg = (v: unknown): string | null => (v === null ? null : snowflakeArg(v, 'server'));

/** Filled options checked (they come from the renderer). */
function checkValues(v: unknown): CommandRun['values'] {
  if (!Array.isArray(v)) throw new Error('Not command options.');
  return v.map((o: Partial<CommandRun['values'][number]> | null) => {
    if (!o || typeof o.type !== 'number' || !['string', 'number', 'boolean'].includes(typeof o.value)) throw new Error('Not a command option.');
    return { name: text(o.name, 'option name'), type: o.type, value: typeof o.value === 'string' ? text(o.value, 'option value', VALUE_TEXT_MAX) : o.value! };
  });
}

function checkRun(v: unknown): Omit<CommandRun, 'files'> {
  const r = v as Partial<CommandRun> | null;
  if (!r || !r.command || !Array.isArray(r.path)) throw new Error('Not a command to run.');
  return {
    channelId: snowflakeArg(r.channelId, 'channel'),
    guildId: guildArg(r.guildId),
    command: {
      id: snowflakeArg(r.command.id, 'command'),
      applicationId: snowflakeArg(r.command.applicationId, 'app'),
      version: snowflakeArg(r.command.version, 'command version'),
      name: text(r.command.name, 'command name'),
    },
    path: r.path.map((p) => text(p, 'subcommand')),
    values: checkValues(r.values),
  };
}

const isFile = (f: unknown): f is OwnerFile => {
  const o = f as Partial<OwnerFile> | null;
  return !!o && typeof o.name === 'string' && o.name.trim() !== '' && o.bytes instanceof Uint8Array;
};

/** A command's `data.options`: the filled options, nested under its group and subcommand. */
function nestOptions(path: string[], leaf: unknown[]): unknown[] {
  return path.reduceRight<unknown[]>((inner, name, i) => [{ type: i === path.length - 1 ? OPTION.subcommand : OPTION.group, name, options: inner }], leaf);
}

/** Runs interactions through the client's session and settles each from the gateway result bearing its nonce. */
export class Interactions {
  private readonly pending = new Map<string, Pending>();

  /** Subscribe before the client opens its socket (as the tap requires). */
  constructor(
    tap: GatewayTap,
    private readonly api: DiscordClient,
    private readonly account: OwnerAccount,
  ) {
    tap.on('dispatch', ({ t, d }) => this.onDispatch(t, d as { nonce?: string }));
  }

  /** Runs a slash command; uploads the files its attachment options name first. */
  async runCommand(v: unknown): Promise<InteractionOutcome> {
    const run = checkRun(v);
    const files = (v as { files?: unknown }).files;
    if (!Array.isArray(files) || !files.every((f: { name?: unknown; file?: unknown }) => typeof f?.name === 'string' && isFile(f.file))) throw new Error('Not files for the command.');
    const named = files as CommandRun['files'];
    const tooBig = named.find((f) => f.file.bytes.length > DISCORD_UPLOAD_BYTES_MAX);
    if (tooBig) throw new Error(`${tooBig.file.name} is over Discord's upload limit.`);
    const attachments = await uploadFiles(this.api, run.channelId, named.map((f) => ({ name: f.file.name, bytes: Buffer.from(f.file.bytes) })));
    // An attachment option's value is its file's index in `attachments`.
    const leaf = [...run.values, ...named.map((f, i) => ({ type: OPTION.attachment, name: f.name, value: i }))];
    return this.post('run', { ...run, applicationId: run.command.applicationId }, {
      type: INTERACTION.command,
      data: { version: run.command.version, id: run.command.id, name: run.command.name, type: 1, options: nestOptions(run.path, leaf), attachments },
    }) as Promise<InteractionOutcome>;
  }

  /** The app's suggestions for the option being typed. */
  async autocomplete(v: unknown): Promise<CommandChoice[]> {
    const run = checkRun(v);
    const f = (v as Partial<AutocompleteRequest>).focused;
    if (!f || typeof f.type !== 'number') throw new Error('Not an option to suggest for.');
    const focused = { type: f.type, name: text(f.name, 'option name'), value: text(f.value, 'option value', VALUE_TEXT_MAX), focused: true };
    return this.post('autocomplete', { ...run, applicationId: run.command.applicationId }, {
      type: INTERACTION.autocomplete,
      data: { version: run.command.version, id: run.command.id, name: run.command.name, type: 1, options: nestOptions(run.path, [...run.values, focused]), attachments: [] },
    }) as Promise<CommandChoice[]>;
  }

  /** Presses a button or picks from a select menu on a bot's message. */
  useComponent(v: unknown): Promise<InteractionOutcome> {
    const c = v as Partial<ComponentUse> | null;
    if (!c || typeof c.componentType !== 'number' || typeof c.messageFlags !== 'number') throw new Error('Not a button or menu.');
    const values = c.values === undefined ? undefined : Array.isArray(c.values) ? c.values.map((x) => text(x, 'menu value')) : null;
    if (values === null) throw new Error('Not menu values.');
    const ctx = { channelId: snowflakeArg(c.channelId, 'channel'), guildId: guildArg(c.guildId), applicationId: snowflakeArg(c.applicationId, 'app') };
    return this.post('run', ctx, {
      type: INTERACTION.component,
      message_flags: c.messageFlags,
      message_id: snowflakeArg(c.messageId, 'message'),
      data: { component_type: c.componentType, custom_id: text(c.customId, 'component id'), ...(values ? { values } : {}) },
    }) as Promise<InteractionOutcome>;
  }

  /** Sends a filled-in bot form. */
  submitModal(v: unknown): Promise<InteractionOutcome> {
    const s = v as Partial<ModalSubmit> | null;
    const m = s?.modal;
    if (!m || !Array.isArray(m.fields) || !s.values || typeof s.values !== 'object') throw new Error('Not a form to send.');
    const values: ModalSubmit['values'] = {};
    for (const [k, x] of Object.entries(s.values)) values[text(k, 'field id')] = Array.isArray(x) ? x.map((y) => text(y, 'field value')) : text(x, 'field value', VALUE_TEXT_MAX);
    const ctx = { channelId: snowflakeArg(m.channelId, 'channel'), guildId: guildArg(m.guildId), applicationId: snowflakeArg(m.applicationId, 'app') };
    return this.post('run', ctx, {
      type: INTERACTION.modalSubmit,
      data: { id: snowflakeArg(m.id, 'form'), custom_id: text(m.customId, 'form id'), components: modalSubmission(m.fields, values) },
    }) as Promise<InteractionOutcome>;
  }

  private async post(kind: Pending['kind'], ctx: Pending['context'], body: Record<string, unknown>): Promise<unknown> {
    const n = newNonce();
    const settled = new Promise((resolve, reject) => this.pending.set(n, { kind, context: ctx, resolve, reject }));
    try {
      await this.api.post('interactions', {
        ...body,
        application_id: ctx.applicationId,
        ...(ctx.guildId ? { guild_id: ctx.guildId } : {}),
        channel_id: ctx.channelId,
        session_id: this.account.sessionId,
        nonce: n,
      });
    } catch (err) {
      this.pending.delete(n);
      throw err;
    }
    // The gateway result may already have settled it while the POST returned.
    const p = this.pending.get(n);
    if (p) p.timer = setTimeout(() => this.settle(n, new Error('The app did not respond.')), kind === 'autocomplete' ? AUTOCOMPLETE_TIMEOUT_MS : ACK_TIMEOUT_MS);
    return settled;
  }

  private onDispatch(t: string, d: { nonce?: string }): void {
    if (!d?.nonce || !this.pending.has(d.nonce)) return;
    const p = this.pending.get(d.nonce)!;
    switch (t) {
      case 'INTERACTION_SUCCESS':
        if (p.kind === 'run') this.settle(d.nonce, { kind: 'done' });
        return;
      case 'INTERACTION_MODAL_CREATE':
        this.settle(d.nonce, { kind: 'modal', modal: toModal(d as RawModal, p.context) });
        return;
      case 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE':
        this.settle(d.nonce, (d as { choices?: CommandChoice[] }).choices ?? []);
        return;
      case 'INTERACTION_FAILURE':
        this.settle(d.nonce, new Error('The app did not respond.'));
        return;
    }
  }

  private settle(n: string, result: unknown): void {
    const p = this.pending.get(n);
    if (!p) return;
    this.pending.delete(n);
    clearTimeout(p.timer);
    if (result instanceof Error) p.reject(result);
    else p.resolve(result);
  }
}

function toModal(d: RawModal, ctx: Pending['context']): BotModal {
  return {
    id: d.id,
    applicationId: d.application?.id ?? ctx.applicationId,
    appName: d.application?.name ?? '',
    channelId: d.channel_id,
    guildId: ctx.guildId,
    customId: d.custom_id,
    title: d.title,
    fields: modalFieldsFrom(d.components),
  };
}
