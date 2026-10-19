// A bundled plugin's archive services (docs/plugin-architecture.md §3–§4): reads, extension points over stored text and
// its notices to open views. Registrations are dropped when the plugin turns off.
import { archivePayloads, type ArchivePayloadReader } from './archivePayloads';
import { archiveReplyExists, archiveReplyFlags, archiveReplyTargets, type ArchiveReplyExists, type ArchiveReplyReader, type ArchiveReplyTargets } from './archiveReplies';
import { registerTextCoverage, type CoverageSpan } from '../textCoverage';
import { registerMessageLabels, type MessageLabelProvider } from '../messageLabels';
import type { AppEvent, ArchiveMessage, IngestResult } from '@shared/contract';
import type { RawChannel, RawGuild, RawMessage } from '@shared/discord';
import { PluginInactiveError } from '@shared/pluginCall';
import type { Archive } from '../archive';
import type { Arrival, Arrived, TextMessage } from '../arrival';
import { registerAttachmentNotes, registerPartNotes, type AttachmentNoteProvider, type PartNoteProvider, type PluginNote } from '../attachmentNotes';
import { partTexts, tagDerivedParts, type PartText } from '../derivedText';
import { messageParts, type MessagePart } from '../messageParts';
import { messageImages, type LinkImage, type MessageImage } from '../messageImages';
import { messagesByIds } from '../queries/messages';
import { archiveSearch, type ArchiveSearchHit, type ArchiveSearchOptions } from '../queries/archiveSearch';
import { archiveSearchCount, type ArchiveSearchCount, type ArchiveSearchGroup } from '../queries/archiveSearchCount';
import { archiveLinksSql, metadataScopeSql } from '../queries/linkMetadata';
import { CONVERSATION_SQL } from '../conversations/read';
import { aiSources, type AiReader } from '../ai/readScope';
import type { ArchiveToolScope } from '../ai/archiveTools';
import { lastReader, messageRead } from '../queries/readMarks';
import type { HostDeps, Registrations } from './api';
import type { BundledDeps, DerivedText, HostPlugins, TextSource } from './bundled';

/** The archive's ingest for an importer (archive.store()); every write throws PluginInactiveError once the activation ended. */
export interface Importer {
  /** Runs `fn` as one transaction: all of its writes or none. */
  atomically<T>(fn: () => T): T;
  upsertGuilds(guilds: RawGuild[]): void;
  upsertChannels(guildId: string, channels: RawChannel[]): void;
  /** Archives the channel (sync keeps it current), or stops archiving it. */
  setOptIn(channelId: string, on: boolean): void;
  /** Stores messages as a re-fetch does (changed text becomes a revision), as arrived `via`. */
  ingestMessages(messages: RawMessage[], via: Arrival): IngestResult;
}

/** Archive services scoped to one bundled plugin. */
export interface PluginArchive {
  /** Matches any distinctive word across message, derived and link text, best match first. Ignores stopwords and short words; none remaining means no hits. Applies privacy and scope. */
  search(query: string, opts: ArchiveSearchOptions): ArchiveSearchHit[];
  /** Counts all search matches once, highest count first, with bounded groups. null query counts all scoped messages. */
  searchCount(query: string | null, opts: ArchiveSearchOptions, group: ArchiveSearchGroup): ArchiveSearchCount[];
  /** Read-only link SELECT with scoped metadata and metadata_channel_ids provenance. Scoped reads default to hosted policy; unscoped reads are for display. */
  linksSql(scope?: ArchiveToolScope, reader?: AiReader | 'display'): string;
  /**
   * Read-only SELECT of one message's conversation from stored links, its one parameter the message id: `message_id,
   * channel_id, ts, parent_id, kind, confidence`, root first, bounded. Privacy applied; scope is the caller's.
   */
  conversationSql(): string;
  /** Payload metadata for selected ids, including compressed payloads; background reads retain their original scope. */
  payloads: ArchivePayloadReader;
  /** Indexed early-exit reply check over original archive data. */
  replyExists: ArchiveReplyExists;
  /** The owner has read the message: in the Archive, on Discord (another client), or it is their own. False when not stored. */
  messageRead(messageId: string): boolean;
  /** Reply status only, for ids the caller already selected. */
  replyFlags: ArchiveReplyReader;
  /** What selected replies answer, from the target Discord embedded in each; ids retain the caller's scope. */
  replyTargets: ArchiveReplyTargets;
  /** Spans the plugin covers; text retention removes only covered text. Data only: the host builds the SQL. */
  textCoverage: { provide(read: () => readonly CoverageSpan[]): void };
  /** Archived attachments, content-addressed. */
  attachmentsDir: string;
  /** The archive's ingest, for importers; a handle held past the activation refuses writes. */
  store(): Importer;
  /** The Archive re-reads this channel. */
  changed(channelId: string): void;
  /** Channels were opted in or out (an import). */
  optInChanged(): void;
  /**
   * Every stored message text, with how it arrived; `source` 'transcript': derived text for it settled. Runs inside
   * ingest, so it must only note work, never do it.
   */
  onText(fn: (m: TextMessage, arrived: Arrived, source: TextSource) => void): void;
  /** An attachment reached the store, before the storage cap may prune it. */
  onAttachmentStored(fn: (attachmentId: string) => void): void;
  /** Debounced archive changes, including global changes, with kinds, insert ranges and plugin ids. */
  onChanged(fn: (change: import('@shared/contract').ArchiveChange) => void): void;
  /** Privacy mode or the channels and servers it hides changed. */
  onPrivacyChanged(fn: () => void): void;
  /** Messages as the Archive shows them; ids not archived, or hidden by privacy mode, are left out. */
  messages(ids: string[]): ArchiveMessage[];
  linkIndex: {
    /** The host rebuilt `links` and `message_links` from stored messages; runs inside that transaction. */
    onRebuilt(fn: () => void): void;
  };
  derivedText: {
    /** Whether the plugin's text for a message is still coming (queued, running, or waiting for its source). */
    provide(p: { pending(messageId: string): boolean }): void;
    /** Settles plugin message text, indexes it and dispatches an edit. null means absent; record bookkeeping shares the transaction. */
    settle(messageId: string, t: DerivedText | null, record?: () => void): void;
    /** Any plugin's text for the message is still coming. */
    pending(messageId: string): boolean;
    /** Some plugin's text for a message settled. */
    onSettled(fn: (messageId: string) => void): void;
    /** Every plugin's texts of these messages' parts (DerivedText.part), its own included; empty ones left out. */
    ofParts(messageIds: readonly string[]): PartText[];
    /** Assigns parts to this plugin’s unassigned texts. Existing parts remain; no rematching occurs. */
    tagParts(parts: ReadonlyMap<string, string>): void;
  };
  parts: {
    /** Each message's parts (media of every kind, embeds' text), in the order it shows them; one with none is left out. */
    of(messageIds: readonly string[]): Map<string, MessagePart[]>;
    /** As images.onShown: a message was stored or updated, or a link it shares gained images or text. Must only note work. */
    onShown(fn: (messageId: string) => void): void;
  };
  images: {
    /** Each message's images (attachments, embeds, link images), in the order it shows them; one with none is left out. */
    of(messageIds: readonly string[]): Map<string, MessageImage[]>;
    /** Reports stored/updated messages or newly available link images during ingest. Handlers must record work without executing it. */
    onShown(fn: (messageId: string) => void): void;
  };
  linkImages: {
    /** Replaces plugin images for a URL and reports sharing messages to images.onShown. record bookkeeping shares the transaction. */
    set(url: string, images: readonly LinkImage[], record?: () => void): void;
  };
  linkText: {
    /** Upserts plugin link text ahead of Discord previews. Newly covered messages are rejudged; record bookkeeping shares the transaction. */
    set(url: string, text: string, record?: () => void): void;
  };
  messageLabels: {
    provide(fn: MessageLabelProvider): void;
    /** Null refreshes all loaded messages. */
    changed(messageIds: string[] | null): void;
  };
  /** Notes keyed by attachment id; a plugin provides these or `notes`, not both. */
  attachmentNotes: {
    provide(fn: AttachmentNoteProvider): void;
    /** These messages' notes changed: open views re-read them. */
    changed(messageIds: string[]): void;
  };
  /** Notes keyed by message part (an attachment, an embed's media or text), drawn under what they are of. */
  notes: {
    provide(fn: PartNoteProvider): void;
    /** These messages' notes changed: open views re-read them. */
    changed(messageIds: string[]): void;
  };
}

/** Plugin `id`'s derivedText.settle, ungated: stores its text (or none) and tells the plugins waiting on the message. */
export const derivedTextSettler =
  (id: string, bundled: BundledDeps, plugins: HostPlugins) =>
  (messageId: string, t: DerivedText | null, record?: () => void): void => {
    if (t) bundled.storeText(id, messageId, t, record);
    else record?.();
    plugins.textSettled(messageId);
  };

/** Plugin `id`'s importer: each write reaches the archive open now, while `live`; after, it throws PluginInactiveError. */
function importer(id: string, bundled: BundledDeps, live: () => boolean): Importer {
  const archive = (): Archive => {
    if (!live()) throw new PluginInactiveError(id);
    return bundled.archive();
  };
  return {
    atomically: (fn) => archive().atomically(fn),
    upsertGuilds: (guilds) => archive().upsertGuilds(guilds),
    upsertChannels: (guildId, channels) => archive().upsertChannels(guildId, channels),
    setOptIn: (channelId, on) => archive().setOptIn(channelId, on),
    ingestMessages: (messages, via) => archive().ingestMessages(messages, via),
  };
}

/** Builds a plugin's archive services; `ask` runs plugin code while live with a fallback, recording a throw; `send` emits while live. */
export function pluginArchive(
  id: string,
  buildIndex: number,
  deps: HostDeps & { bundled: BundledDeps },
  reg: Registrations,
  plugins: HostPlugins,
  live: () => boolean,
  ask: <T>(fn: () => T, fallback: T) => T,
  send: (e: AppEvent) => void,
): PluginArchive {
  const { bundled } = deps;
  const settle = derivedTextSettler(id, bundled, plugins);
  const sources = aiSources(bundled.ready, (provider) => bundled.providers.isLocal(provider));
  return {
    search: (query, opts) => live() ? archiveSearch(bundled.ready(), query, opts, sources) : [],
    searchCount: (query, opts, group) => live() ? archiveSearchCount(bundled.ready(), query, opts, group, sources) : [],
    linksSql: (scope, reader = scope?.reader) => {
      const policy = reader !== 'display' && (scope || reader) ? sources.sql('s.channel_id', reader ?? 'hosted') : '1';
      return archiveLinksSql(live() ? `${scope ? metadataScopeSql(scope) : '1'} AND ${policy}` : '0', false, true);
    },
    conversationSql: () => CONVERSATION_SQL,
    payloads: (ids) => live() ? archivePayloads(bundled.ready(), ids) : new Map(),
    replyExists: (...args) => live() && archiveReplyExists(deps.db, ...args),
    messageRead: (messageId) => live() && messageRead(deps.db, messageId, plugins.self() ?? lastReader(deps.db)),
    replyFlags: (ids) => live() ? archiveReplyFlags(deps.db, ids) : new Map(),
    replyTargets: (ids) => live() ? archiveReplyTargets(deps.db, ids) : new Map(),
    textCoverage: {
      provide: (read) => {
        if (live()) reg.disposers.push(registerTextCoverage(() => ask(read, [])));
      },
    },
    attachmentsDir: bundled.attachmentsDir,
    store: () => importer(id, bundled, live),
    changed: (channelId) => void (live() && deps.changed(channelId, ['plugin'], { pluginId: id })),
    optInChanged: () => send({ type: 'opt-in-changed' }),
    onText: (fn) => void reg.onText.push(fn),
    onAttachmentStored: (fn) => void reg.onAttachmentStored.push(fn),
    onChanged: (fn) => void reg.onArchiveChanged.push(fn),
    onPrivacyChanged: (fn) => void (live() && reg.onPrivacyChanged.push(fn)),
    messages: (ids) => messagesByIds(bundled.ready(), ids),
    linkIndex: { onRebuilt: (fn) => void reg.onLinksRebuilt.push(fn) },
    derivedText: {
      provide: (p) => void reg.textPending.push((messageId) => p.pending(messageId)),
      settle: (messageId, t, record) => void (live() && settle(messageId, t, record)),
      pending: plugins.textPending,
      onSettled: (fn) => void reg.onTextSettled.push(fn),
      ofParts: (ids) => (live() ? partTexts(bundled.ready(), ids) : []),
      tagParts: (parts) => void (live() && tagDerivedParts(bundled.ready(), `${id}:`, parts)),
    },
    parts: {
      of: (ids) => (live() ? messageParts(bundled.ready(), ids) : new Map()),
      onShown: (fn) => void reg.onShown.push(fn),
    },
    images: {
      of: (ids) => (live() ? messageImages(bundled.ready(), ids) : new Map()),
      onShown: (fn) => void reg.onShown.push(fn),
    },
    linkImages: {
      set: (url, images, record) => void (live() && bundled.storeLinkImages(id, url, images, record)),
    },
    linkText: {
      set: (url, text, record) => void (live() && bundled.storeLinkText(id, url, text, record)),
    },
    messageLabels: {
      provide: (fn) => {
        if (live()) reg.disposers.push(registerMessageLabels(id, buildIndex, (ids) => ask(() => fn(ids), new Map())));
      },
      changed: (messageIds) => send({ type: 'message-labels-changed', messageIds }),
    },
    attachmentNotes: {
      // Notes are read inside every page read: a throw is recorded on the plugin and its notes are left out, never failing the page.
      provide: (fn) => {
        if (live()) reg.disposers.push(registerAttachmentNotes(id, buildIndex, (ids) => ask(() => fn(ids), new Map<string, PluginNote>())));
      },
      changed: (messageIds) => send({ type: 'attachment-notes-changed', messageIds }),
    },
    notes: {
      provide: (fn) => {
        if (live()) reg.disposers.push(registerPartNotes(id, buildIndex, (ids) => ask(() => fn(ids), new Map<string, Map<string, PluginNote>>())));
      },
      changed: (messageIds) => send({ type: 'attachment-notes-changed', messageIds }),
    },
  };
}
