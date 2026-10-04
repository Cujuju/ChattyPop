# Direct messages: see, archive, send, manage

Status: implemented (2026-10-01), from design rev 2 after Codex and Opus reviews; deviations in §8. Read with `research.md` §0, §6 and §10.

## 1. Today

| Capability | State |
|---|---|
| Archive a DM or group DM | Works, once opted in per DM in Browse → "Direct messages". Backfill, the live tap, edits, deletes and reactions all apply. |
| Read, send, reply, attach, edit, delete, react, forward, slash commands, @ list | Work. The Archive view and composer are type-agnostic. |
| Mark read | Partial. Viewing acks the newest *stored* message, so an empty DM is never acked (`archiveHandlers.ts:64`). |
| DM list | Stale. REST `users/@me/channels` is fetched only when Browse expands a DM group that has *zero* rows (`Browse.tsx:19`), so in practice once per archive, plus on every Forward open (`state/forward.ts:33`). READY `private_channels` and the DM `CHANNEL_*` dispatches are ignored. |
| Ordering | The sidebar uses the last-message rank frozen at fetch time. Forward sorts by the newest archived message. |
| Faces | The sidebar shows `@` plus the name, and only Forward shows avatars. Group recipients aren't stored, so a group's @ list is only the people who have posted. |
| Unread | `mentionCount` is Discord's DM count: every message in an unmuted DM counts (`readStates.ts:188`). There's no ack id or mute state in core. |
| Start a DM | Profile card → Message POSTs `users/@me/channels` on every click and opens the live client; `/msg` posts blind. Neither one updates the directory. |
| Manage | Absent. |
| Account | One archive serves every account. DM rows aren't scoped to the account signed in. |
| Headers | `capture.ts:14` replays *every* `x-*` header of the client's latest request on the app's own requests, including the per-request `X-Context-Properties`. This is a bug, and it's fixed here. |

## 2. Goals and non-goals

Goals:
1. All of the signed-in account's DMs are listed, with face, activity and Discord's unread and mute state, and the list stays current from the client's own gateway at zero extra requests.
2. Any DM opens in the Archive view. One click archives it, and an optional rule archives DMs automatically when they get a message.
3. Start a DM or group with friends from the app.
4. Manage a DM in the app: mark read, mute, close, leave, rename a group, add friends. Rarer actions (remove a person, change the group icon) open the live client.
5. The architecture laws hold. In particular, every write uses the live client's exact request shape (law 4, research §1).

Non-goals, each filed as an issue:
- Accepting or ignoring message requests and spam. They're shown in a Requests fold, read-only, and never auto-archived.
- Blocking and friend management.
- "Hide all DMs" in privacy mode. It needs DM-wide semantics, because `@me` must not enter `hidden_ids`, where it would substring-match message text (`queries/privacy.ts:16`).
- Account-scoping the rest of the archive.
- Calls.

## 3. Data

### 3.1 Source: the client's gateway only

- **No REST list fetch.** The tap attaches before `loadURL` (`discordView.ts:94,118`), so READY is always seen. The `@me` REST refresh in Browse and Forward is removed. That also removes the race where a late REST response resurrects a closed DM.
- **READY.** `main/discord/privateChannels.ts` (new) is subscribed before `loadURL`, like `guildIndex`. It normalizes READY `private_channels` into `RawPrivateChannel`, resolving `recipient_ids` through READY's `users` when `recipients` is absent and accepting both bare and `{entries}` lists (`entriesOf`). It first hands core READY's `user` (`setSelf`), so every later delta and query sees the account signed in now, even after a token switch without a 401; READY is core's only source of the signed-in user. It then calls core `replacePrivateChannels(selfId, list)`. A DM of that account missing from the list gets `closed_at` set; it's never deleted. If READY's list is partial, or READY leaves it out, close nothing; the same holds for its read states and notification settings (§3.3).
- **Deltas.** `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `CHANNEL_RECIPIENT_ADD` and `CHANNEL_RECIPIENT_REMOVE` join `ARCHIVED_GATEWAY_EVENTS` and are handled in `core/gatewayEvents.ts`: types 1 and 3 only, and an exhaustive switch.
- **Activity.** In `gatewayEvents.ts`, `MESSAGE_CREATE` (already forwarded unfiltered by `app.ts:182`) calls `touchChannel(channelId, messageId)` for DMs (a message without `guild_id`; a server's message costs no lookup) before ingest. It writes no content for an unarchived DM. `last_message_id` only ever rises, as `max(old, new)` by snowflake. A message in a closed one-to-one DM clears its `closed_at`, as Discord reopens it (§3.6).
- **Merging.** Gateway deltas and READY merge field by field: an absent field keeps its stored value and `null` clears it. Rank is computed from `last_message_id` at query time, never stored per upsert. The roster is replaced only by READY or by a full channel object carrying recipients. Names: an absent `name` keeps the stored one; `name: null` (an unnamed group) and a one-to-one DM, which has no name of its own, take their people's names only once the roster is resolved, so an unresolved roster never puts "Direct message" over a stored name.

### 3.2 Schema (`laterMigrations.ts`, additive only)

Other builds may share a profile, so no column is dropped.

- `channels.account_id TEXT`: the account a private channel belongs to, written from `selfId` on every private upsert. Directory and replace queries filter on the current self. Legacy rows with no account are claimed by a READY that lists them; a full READY also claims, then closes, an unlisted one holding a stored message its user wrote. Every other unclaimed row is hidden from every DM list, never deleted, and before any self is known no DM is listed.
- `channels.last_message_id TEXT`, `channels.owner_id TEXT`, `channels.closed_at INTEGER`.
- `channels.is_message_request INTEGER` and `channels.is_spam INTEGER`: Discord's two flags, each merged on its own (a payload without one keeps it). `dm.request` is either. Assumption: these fields are present on user-account private channels; confirm them in a captured READY.
- `channels.auto_declined INTEGER`: the owner stopped archiving this DM, or unchecked "Archive" when starting it, so auto-archive skips it.
- `channels.recipients` (JSON user ids; NULL while unknown): the roster, every member except self, owner included. It's the one roster store, shared with the `@` list (`queries/mentions.ts`). `users` rows are upserted with it.
- `peer_id` stays and is still written for 1:1 DMs; old builds read it. Membership and the face are kept apart. `dm.recipients` and the `@` list come from the roster alone: its people plus self, never past speakers, so a removed member isn't offered. Only while the roster is unknown is `dm.recipients` empty and the `@` list falls back to who posted. The face for display is the channel's `peer` (`peer_id`, else, only while the roster is unknown, the newest non-self sender) or a group's `icon`; a known roster never reads history for a face.

### 3.3 Read and mute state (main owns it)

`ReadStates` already holds the ack ids and DM channel overrides. Its `putReadStates` projection to core gains, per DM, `ackId` and `muteEndsMs` (`null` = not muted, `MUTED_FOREVER` = until unmuted). It's re-sent on `MESSAGE_ACK`, `USER_GUILD_SETTINGS_UPDATE`, a DM's `CHANNEL_CREATE` and READY. Core stores them in `read_states` (new columns). Every field, the mention count included, is left out while main doesn't know it, and core keeps its stored value. A partial READY merges into main's cache; a READY for another account drops that cache and replaces core's stored states. Then:
- unread = `last_message_id > ackId`
- muted = `muteEndsMs > now`, evaluated in the renderer against a shared minute clock, so expiry needs no dispatch.

### 3.4 Contract (`shared/types/archive.ts`)

`DirectoryChannel` keeps `peer` and `icon` (Forward and plugins use them) and gains an optional `dm` block, present for kinds 1 and 3:

```ts
dm?: {
  recipients: { id: string; name: string; avatar: string | null }[]; // the roster: members without self, owner included; empty while unknown
  rosterKnown: boolean; // false while Discord hasn't named the members: no count, no owner crown, no "Remove people"
  ownerId: string | null;
  lastMessageId: string | null;
  ackId: string | null;
  muteEndsMs: number | null;
  closed: boolean;
  request: boolean;
  archived: 'never' | 'on' | 'stopped';  // 'stopped': not opted in, history kept
  preview: { authorName: string; text: string } | null; // newest message passing visibleMessageSql, text pruned per tier
}
```

- The phone and plugins get the same shape, through `directory` and the SDK. Previews obey privacy mode through `visibleMessageSql`.
- Two new events patch the renderer's directory resource in place, so the whole directory isn't re-queried per DM message: `dm-activity {channelId, lastMessageId}` (the id only rises), and `read-states-changed {states}` for main's read state updates (counts, ack ids, mute ends; a field left out stays). Both are emitted only for channels privacy mode leaves visible, so a hidden DM's activity reaches no view, phone or plugin. A patch that lands while a directory read is in flight applies to that read's answer too, which may predate it. `archive-changed ''` stays for list changes (create, close, roster changes) and READY's read states.

### 3.5 Discord writes (`main/discord/dms.ts`; `DiscordWriter`; prompt lane)

Shapes are read from the live client's own action creators (its loaded JS, read over CDP, 2026-10-01). `ctx` means the client sends `X-Context-Properties: base64(JSON {location})` for that call; `ctx {}` means it sends `e30=`, base64 of `{}`, as for a DM opened from a profile.

| Action | Request |
|---|---|
| Open an existing 1:1 | No request. The client opens its cached DM, and the app does the same from the directory. |
| Start a DM or group | `POST users/@me/channels {recipients}`, ctx `"New Group DM"` from the New message window, ctx `{}` from the profile card's Message and `/msg`. The client retries 3×; we use `postOnce` and never re-POST on an ambiguous failure, waiting for `CHANNEL_CREATE` instead. |
| Add a friend | `PUT channels/{id}/recipients/{userId}`, ctx `"Add Friends to DM"`. On a 1:1 the response is `201` with a **new group** channel; on a group it's `204`. Several people mean one PUT each, in order, as the client does. |
| Remove a person (owner) | `DELETE channels/{id}/recipients/{userId}`. Not offered in the app (§2). |
| Close a DM / leave a group | `DELETE channels/{id}?silent={bool}`, sent once. It's the same call for both. Closing a DM sends `silent=false`, and leaving a group sends "Leave quietly" as `silent=true`. |
| Rename a group | `PATCH channels/{id} {name}` |
| Mute | `PATCH users/@me/guilds/@me/settings {channel_overrides:{[id]:{muted:true, mute_config:{selected_time_window, end_time}}}}`. `selected_time_window` is in seconds, from the client's set: 900, 3600, 10800, 28800, 86400, or -1 for always, which sends `end_time: null`. |
| Unmute | Same path, `{channel_overrides:{[id]:{muted:false}}}` |
| Mark read | `POST channels/{id}/messages/{last_message_id}/ack`, the existing ack path, now using `last_message_id`, so unarchived and empty DMs ack too |

Rules:
- Main validates every write: the channel is a private channel of the current account, open, and no message request (close, mute, rename and add refuse one); recipients are friends, deduplicated, not self, and within `GROUP_DM_MAX_MEMBERS` (10, Discord's cap, owner included); rename applies to groups only.
- **Account boundary.** A write captures the account at validation, which READY must have named in main and core alike. Just before it is sent, after any queue wait, a guard (`RequestOptions.guard`) aborts it unsent if main's READY account differs. Its answer is stored under the captured account (`applyDmWrite`); once another account is signed in, core skips it and the gateway owns it. The renderer's friend list is read again on `self-changed`; main's `FriendIndex` resets on every READY.
- Each call returns the server's channel object. Core upserts it immediately, and the gateway echo is idempotent through §3.1 merging. Nothing is optimistic, and no write depends on a dispatch arriving. A close is the exception (§8).
- **New conversations.** Start and add carry the window's archive choice to main. Core applies it (opt-in, or `auto_declined`) in the same call that stores the channel the write made, so no `MESSAGE_CREATE` for it can auto-archive it first. "Made" means core didn't hold the channel before the request: when Discord answers a start with an id already stored (a closed 1:1 reopened), the outcome is `opened` and that DM keeps its archive state and `auto_declined`.
- **Part-done adds.** When a later PUT fails after one went through, the outcome still names the conversation (`created` for the group a 1:1's first PUT made) with `failed: {userIds, reason}`. The window retargets to it, and a retry adds only those people there.
- **Header fix.** `HeaderCapture` keeps only session-wide `x-*` headers (an allowlist matching what the client's request hook sets on every call: `X-Super-Properties`, `X-Fingerprint`, `X-Installation-ID`, `X-Discord-Locale`, `X-Discord-Timezone`, `X-Debug-Options`). Calls that carry a context pass it explicitly as `{location}`, base64-encoded the way the client encodes it.
- `profiles.dmChannel` and `send.sendDirect` move onto this one service.

### 3.6 Archive policy

- Per-DM opt-in stays. Research §0 gains a DM row stating this policy.
- New setting, Settings → Archive, default **off**: "Archive DMs automatically when they get a message". Turning it on stores `autoArchiveSinceMs`. In the gateway handler, before ingest, a `MESSAGE_CREATE` opts its DM in when all of these hold:
  - the DM belongs to the current account
  - its timestamp is after `autoArchiveSinceMs`
  - the DM isn't a request and isn't `auto_declined`

  The triggering message is then stored, and core emits `opt-in-changed`. Main enqueues sync on that event (today it enqueues only after its own `setOptIn`), so backfill runs through the existing queue. One DM is added at a time as messages arrive, so turning the setting on never triggers a mass backfill.
- **Closed groups.** A closed group (left, or removed from it) leaves the sync set, and its composer is hidden. A closed 1:1 still accepts a message, which reopens it as Discord does.
- **Sync scope.** Sync keeps only the current account's archived DMs (`optedInChannels`); another account's, an unclaimed legacy row and every DM before READY names an account are left out, as in the directory. READY naming a new account queues its DMs (`optedInDms`). Queued or running sync rechecks before each page (`syncable`, through the request guard): still archived, the current account's, not a closed group. Otherwise it stops quietly.
- **Read-only DMs.** Core's `setOptIn(true)` refuses a message request, a closed group and another account's DM. The UI offers no Archive or Resume for either (DmState, the row menu), and `postable()` gives neither a composer.
- **Open behaviour.** A row follows the active source, like every channel row. In Live mode it moves the client. In Archive mode, depending on `archived`:
  - `on`: history plus the composer.
  - `stopped`: history read-only, with a "Not archiving · Resume" bar.
  - `never`: an empty state with "Archive this conversation" and "Open in Discord".

  `ArchiveView` accepts a DM in any of the three states. Today it shows only opted-in channels.

## 4. UI

### 4.1 Sidebar: Servers | DMs

- A full-width `seg-buttons` band under the Archive header switches modes. The DMs segment carries the unread-DM count.
- The Servers mode no longer shows the Direct messages group, and Browse no longer lists DMs; the DMs mode owns them.
- The phone drawer gets the same switch, read-only: no management actions.

DMs mode:
1. A search field (name or member) and a New message icon action.
2. Filter chips: All · Unread · Groups.
3. Rows (`--cp-dm-row-h`, two lines):
   - `--cp-avatar-md` face; a group shows its icon, else two stacked member avatars
   - name, then a relative time (`5m`, `2h`, `Tue`, `12 Sep`)
   - preview line: `Name: text`, or *Not archived*
   - the mention pill (Discord's count; no second unread badge, to avoid double-counting)
   - bold name while unread
   - a bell-off glyph while muted
   - an archived dot
   - the existing Private, local and backfill micro-tags
4. Folds at the bottom: **Requests · N** and **Closed · N**, both collapsed.

Rail (collapsed sidebar): DMs with a pending mention sit above the servers, as in Discord.

### 4.2 Chat bar for a DM (removed)

Removed with the Archive's picker row: the Archive view has no header. Add friends, Mute and Open in Discord stay in the row menu; the Members flyout has no surface yet.

Face, then name, then "· N members" ("· Members unknown" while the roster is). Actions:
- Add friends
- Mute (a flyout: 15 min · 1 h · 3 h · 8 h · 24 h · Until I turn it back on)
- Members (a flyout: the owner's crown, "Open in Discord to remove" for the owner; neither, and no count, while the roster is unknown)
- Open in Discord

### 4.3 New message window (FloatingWindow, Forward's busy, error and keyboard handling)

- A "To:" token field searching friends (names from READY `relationships` users; `FriendIndex` gains names and avatars) and people the owner already has a 1:1 with.
- Picked people become chips. At two or more people the title reads "New group · N of 10". One person with an existing DM gives "Open conversation", which sends no request.
- An "Archive this conversation" checkbox, checked by default. Unchecked sets `auto_declined`. It goes to main with the write (§3.5).
- On success it opens in the Archive view with the composer focused if archived, otherwise in the live client. A write that finishes after its window closed (or opened afresh) opens nothing.
- Enter in the To field picks the highlighted person, as Forward's Enter picks its target. It sends only with no one highlighted (an empty list), or with Ctrl+Enter.
- Picks still sending, and picks Discord gave no clear answer for, are held in `state/newMessage.ts`, not the window: closing and reopening it can't send them again. One person with an open DM sends nothing, so it is never held. Another account's held picks are dropped on `self-changed`.
- New message offers no message request among "Your DMs".

### 4.4 Row menu (flat `MenuGroup`s; no submenu infrastructure)

```
Mark as read
Mute…                     (opens §4.2's flyout at the row) / Unmute
──
Archive this conversation / Stop archiving      (stop sets auto_declined)
Private · Local AI only · <Jev items>           (existing channelMenu items)
──
Rename… · Add friends…                          (group only)
Open in Discord
──
Close DM  /  Leave group…                       (danger)
```

The profile card's Message button uses §3.5: no POST for an existing DM, and it opens per §3.6.

The rename and leave dialogs close, their fields cleared, once their conversation leaves the list or can't be managed (privacy mode hid it, it closed, another account signed in). Rows are keyed by channel id, so a directory read keeps them and their focus; the row menu's Mute… looks its row up by id as the flyout opens.

### 4.5 Look

- All values come from existing tokens. New size tokens in `sizes.css`: `--cp-dm-row-h` and `--cp-avatar-stack` (a stacked member face). `--cp-avatar-md` already exists.
- No new section colour: DMs are the `channels` section.
- Styling lives in `panels/channels/Dms.module.css`, authored by the design agent (law 3).

## 5. Files

| Layer | Files |
|---|---|
| shared | `types/archive.ts` (`dm` block), `types/ipc.ts` (gateway events, discord methods, `dm-activity`), `discord.ts` (cap, normalizer types), `contract.ts`, `rendererApi.ts`, `phone.ts` / `phoneApi.ts` (desktop-only stubs) |
| main | `discord/privateChannels.ts` (new), `discord/dms.ts` (new), `discord/capture.ts` (allowlist), `discord/readStates.ts` (projection), `discord/profiles.ts` (friend names), `ipc/discord.ts`, `app.ts` (wiring, `opt-in-changed` → enqueue), `sync/syncService.ts` (drop the `@me` REST path) |
| core | `archive.ts`, `gatewayEvents.ts`, `laterMigrations.ts`, `queries/directory.ts`, `queries/mentions.ts`, `queries/readStates.ts`, `archiveHandlers.ts` |
| renderer | `state/dms.ts` (new), `state/directory.ts`, `state/archive.ts`, `state/forward.ts`, `panels/channels/{index,Dms,Rail,Browse}.tsx`, `Dms.module.css`, `panels/chat/ArchiveView.tsx`, the chat bar, `views/newMessage/`, `views/person/ProfileCard.tsx`, settings |
| tests | READY normalizing (`recipients` vs `recipient_ids`, partial); replace closes only the same account's rows; field merging; monotonic touch; no content stored for unarchived DMs; auto-archive gates (baseline, account, request, declined) storing the first message; directory `dm` block, ordering and preview privacy; write validation; header allowlist |

## 6. Phases (each a commit, or several)

1. **Data:** the header allowlist, the gateway feed, the schema, recipients, read and mute projection, the directory `dm` block, `dm-activity`, and tests.
2. **Sidebar:** the DMs mode, rows, filters, search, folds, rail; ArchiveView's three states.
3. **Starting conversations:** the New message window, friend names, the Message button, `/msg` on the shared service.
4. **Manage:** the row menu, the chat bar, the mute flyout, leave confirmation, rename, add friends.
5. **Settings:** auto-archive, then the §0 decision row and docs.

## 7. Residuals

- **Write shapes.** These are from the client build loaded on 2026-10-01. Discord can change them, and a 4xx on any write is logged with its path to diagnostics.
- **Request flags.** They rest on the READY assumption in §3.2, which Phase 1's READY diag checks. If the fields are absent, requests list as ordinary DMs, and auto-archive can pick them up.
- **Token before READY.** The write guard compares READY's account. If the client starts sending another account's token before that account's READY reaches main, a write already queued could go with it. Trigger: an account switch while a DM write waits in the queue.
- **Gateway first.** When the gateway's `CHANNEL_CREATE` for a new conversation arrives before Discord's answer, and a message in it arrives in between, auto-archive may store that message before the archive choice applies. The choice still lands (an unchecked box opts it back out), but the stored message stays. Trigger: someone posts in a group within the moment it is created, with auto-archive on.

## 8. Deviations (as built)

- **Constants.** `GROUP_DM_MAX_MEMBERS`, the name limit and the mute windows live in `shared/dms.ts`, not `discord.ts`: the plugin SDK re-exports `discord.ts`, so adding there would change its surface.
- **Friends only for groups.** One person needs no friendship (the profile's Message and `/msg` reach anyone Discord lets the owner message). Starting a group and adding people take friends only.
- **Add friends on a one-to-one DM** is offered in the row menu. It makes a new group, and the window's archive choice applies to that group.
- **Archive choice.** Main applies it with the write (§3.5, `applyDmWrite`), not the window through `setOptIn`. Core's `setOptIn(false)` sets `auto_declined` and `setOptIn(true)` clears it, which also covers Stop archiving.
- **Mark read** is a core `markDmRead`: it acks Discord's `last_message_id` through the existing `channel-read` → ack path. Viewing still acks the newest stored message, so opening an unarchived DM never marks unseen messages read.
- **Leave confirmation** is a small floating window (`views/dmDialog`), since `window.confirm` can't hold the Leave quietly checkbox. Rename uses the same window.
- **Flyouts.** Mute and Members are the app's context menu opened at their button (`openMenuAt`), sharing its keyboard handling and live-view cover. Members show a crown or person icon, not avatars.
- **Row menu** leaves out channelMenu's Older messages group; the phone's rows keep channelMenu. Mark as read shows only while the DM is unread (`dmRules.isUnread`, the row's bold), as in Discord's client: each one sends an ack.
- **Sync after archiving.** Core's `opt-in-changed` names the channel archived (by hand or by auto-archive), and main enqueues it. The enqueue after the IPC `setOptIn` is gone.
- **Adding to a one-to-one DM** whose first PUT answers without a channel is uncertain, like a start: nobody else is added.
- **Close and leave** are stored from the gateway's `CHANNEL_DELETE` only, never from Discord's answer: a late answer could land after a newer reopen (a message, or `CHANNEL_CREATE`) and close it again. The DELETE is sent once (`once`), so a retry after a server error can't meet Unknown Channel; a server error fails, and if it applied, the gateway still closes it.
- **Account scope of sync** reaches the request guard: a page is checked with core (`syncable`) after its queue wait, not only when the channel is dequeued.
