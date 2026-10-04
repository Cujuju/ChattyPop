import { For, Show, createSignal } from 'solid-js';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { CATEGORY_CHANNEL_TYPE, DM_GUILD_ID } from '@shared/discord';
import { suggestChannels, suggesting, suggestions, suggestNote } from '@/state/channelSuggestions';
import { channelLabel, directory, directoryLoading, isThread, loadDirectory, setChannelOptIn } from '@/state/directory';
import { aiSettings } from '@/state/preferences';
import { channelPrivacyItem, guildPrivacyMenu } from '@/state/privacy';
import { openContextMenu } from '@/state/ui';
import { GuildIcon } from '@/ui/GuildIcon';
import styles from './Browse.module.css';
import listStyles from './Channels.module.css';

/** Every known server, expandable to opt its channels in or out of the archive; Jev can suggest channels. DMs mode owns DMs. */
export function Browse() {
  const [open, setOpen] = createSignal<string | null>(null);
  const toggle = (g: DirectoryGuild): void => {
    const next = open() === g.id ? null : g.id;
    setOpen(next);
    // A server's channels are fetched when first opened.
    if (next && g.channels.length === 0) void loadDirectory(g.id);
  };
  if (directory().length === 0) void loadDirectory();

  return (
    <Show when={!directoryLoading().has('')} fallback={<p class={listStyles.emptyText}>Loading servers…</p>}>
      <For each={directory().filter((g) => g.id !== DM_GUILD_ID)}>
        {(g) => (
          <div class={listStyles.group}>
            <button
              type="button"
              class={`cp-sidebar-heading ${styles.guildToggle}`}
              aria-expanded={open() === g.id}
              onClick={() => toggle(g)}
              onContextMenu={(e) => openContextMenu(e, guildPrivacyMenu(g))}
            >
              <GuildIcon id={g.id} name={g.name} icon={g.icon} />
              <span class={listStyles.guildName}>{g.name}</span>
            </button>
            <Show when={open() === g.id}>
              <Show when={aiSettings().jev.suggestChannels}>
                <div class={styles.suggest}>
                  <button
                    type="button"
                    class={listStyles.emptyAction}
                    disabled={suggesting() !== null}
                    title="Reads recent messages of this server's unarchived channels and asks Jev which match your rules (nothing is stored)"
                    onClick={() => void suggestChannels(g.id)}
                  >
                    {suggesting() === g.id ? 'Reading channels…' : 'Suggest channels'}
                  </button>
                  <Show when={suggestNote()[g.id]}>{(n) => <span class={listStyles.emptyText}>{n()}</span>}</Show>
                </div>
              </Show>
              <Show when={!directoryLoading().has(g.id)} fallback={<p class={listStyles.emptyText}>Loading channels…</p>}>
                <For each={g.channels.filter((c) => !isThread(c))}>{(c) => <ChannelOption channel={c} />}</For>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </Show>
  );
}

function ChannelOption(props: { channel: DirectoryChannel }) {
  const id = () => `optin-${props.channel.id}`;
  return (
    <Show when={props.channel.kind !== CATEGORY_CHANNEL_TYPE} fallback={<div class={styles.category}>{props.channel.name}</div>}>
      <div class={styles.option} onContextMenu={(e) => openContextMenu(e, [{ items: [channelPrivacyItem(props.channel)] }])}>
        <input
          id={id()}
          type="checkbox"
          class={styles.checkbox}
          checked={props.channel.optedIn}
          onChange={(e) => void setChannelOptIn(props.channel.id, e.currentTarget.checked)}
        />
        <label for={id()} class={styles.optionLabel}>
          {channelLabel(props.channel)}
        </label>
        <Show when={!props.channel.optedIn && suggestions()[props.channel.id]}>
          {(s) => (
            <span class={`cp-micro-tag ${styles.suggestTag}`} title={`Jev's estimate (a model's guess): matches ${s().rules.join(', ')}`}>
              suggested
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}
