// Search results as Discord lists them: runs of hits from one channel under its name, each hit an author line and its formatted text.
import { For, Show, createMemo } from 'solid-js';
import type { SearchHit } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { avatarUrl } from '@shared/media';
import { channelById, channelSigil, directory } from '@/state/directory';
import { look } from '@/theme/look';
import { shortDateTime } from '@/ui/format';
import { Markdown } from '@/ui/Markdown';
import styles from './Search.module.css';

/** Consecutive hits in one channel, and the index of its first in the whole list. */
interface ChannelRun {
  channelId: string;
  channelName: string;
  start: number;
  hits: SearchHit[];
}

/** Groups neighbouring hits by channel, keeping the results' order (a channel may head more than one run). */
function channelRuns(hits: readonly SearchHit[]): ChannelRun[] {
  const runs: ChannelRun[] = [];
  hits.forEach((hit, i) => {
    const last = runs.at(-1);
    if (last?.channelId === hit.channelId) last.hits.push(hit);
    else runs.push({ channelId: hit.channelId, channelName: hit.channelName, start: i, hits: [hit] });
  });
  return runs;
}

/** A run's heading: the channel's sigil and name, then its server's (none for a DM). */
function ChannelHeading(props: { run: ChannelRun }) {
  const channel = () => channelById(props.run.channelId);
  const server = () => {
    const guildId = channel()?.guildId;
    return guildId && guildId !== DM_GUILD_ID ? directory().find((g) => g.id === guildId)?.name : undefined;
  };
  return (
    <li class={styles.channel} role="presentation">
      <span class={styles.channelSigil}>{channel() ? channelSigil(channel()!) : '#'}</span>
      <span class={styles.channelName}>{props.run.channelName}</span>
      <Show when={server()}>{(name) => <span class={styles.server}>{name()}</span>}</Show>
    </li>
  );
}

/** Results by channel. Rows are options `search-row-<i>` in list order; a press (mousedown, before the field's blur) opens one. */
export function SearchHits(props: { hits: readonly SearchHit[]; active: () => number; setActive: (i: number) => void; onOpen: (hit: SearchHit) => void }) {
  const runs = createMemo(() => channelRuns(props.hits));
  return (
    <For each={runs()}>
      {(run) => (
        <>
          <ChannelHeading run={run} />
          <For each={run.hits}>
            {(hit, j) => {
              const i = () => run.start + j();
              return (
                <li
                  id={`search-row-${i()}`}
                  role="option"
                  aria-selected={props.active() === i()}
                  class={styles.hit}
                  onMouseEnter={() => props.setActive(i())}
                  onMouseDown={(e) => (e.preventDefault(), props.onOpen(hit))}
                >
                  <img class={`${styles.avatar} ${look.avatar}`} src={avatarUrl(hit.authorId, hit.authorAvatar)} alt="" loading="lazy" />
                  <span class={styles.byline}>
                    <span class={styles.author}>{hit.authorName}</span>
                    <time class={styles.time} dateTime={new Date(hit.ts).toISOString()}>
                      {shortDateTime(hit.ts)}
                    </time>
                  </span>
                  <span class={styles.snippet}>
                    <Markdown text={hit.snippet} mentions={hit.mentions} inert marks />
                  </span>
                </li>
              );
            }}
          </For>
        </>
      )}
    </For>
  );
}
