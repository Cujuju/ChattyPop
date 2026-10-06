// Person Archive summaries remain above tabs for posting locations, links and Discord mutual servers/friends.
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { PersonProfile } from '@shared/contract';
import { fromUserQuery } from '@shared/searchQuery';
import { avatarUrl } from '@shared/media';
import { PersonName } from '@/panels/chat/PersonName';
import { personLinks, personSections } from '@/plugins/slots';
import { openArchive } from '@/state/archive';
import { now, today } from '@/state/clock';
import { discordProfile, mutualFriends, openPerson, showMutualFriends } from '@/state/person';
import { querySearch, setSearchOpen } from '@/state/search';
import { listAge } from '@/ui/dates';
import { shortDate, yearDate } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon } from '@/ui/icons';
import { scrolledFromTop } from '@/ui/scrollEdges';
import { look } from '@/theme/look';
import styles from './PersonTabs.module.css';

type TabId = 'channels' | 'links' | 'servers' | 'friends';

/** A tab; `count` only where the list is whole (channels and links show the top few). */
interface Tab {
  id: TabId;
  label: string;
  count?: number;
  title?: string;
}

/** A count as read, grouped by thousands. */
const figure = (n: number): string => n.toLocaleString();

/** Puts a query in the top-bar search and opens its results. */
function search(query: string): void {
  querySearch(query);
  setSearchOpen(true);
  document.getElementById('archive-search')?.focus();
}

export function PersonTabs(props: { p: PersonProfile }) {
  const [tab, setTab] = createSignal<TabId>('channels');
  // Another person (a mutual friend picked) starts on where they post.
  createEffect(on(() => props.p.id, () => setTab('channels'), { defer: true }));
  const byThem = (): string => fromUserQuery(props.p.id);
  /** Their busiest place's message count: each row's bar is its share of it. */
  const busiest = (): number => Math.max(1, ...props.p.channels.map((c) => c.count));
  const d = () => discordProfile.value();
  const stats = (): { label: string; value: number }[] => [
    { label: 'Messages', value: props.p.totals.messages },
    { label: 'Edited', value: props.p.totals.edited },
    { label: 'Deleted', value: props.p.totals.deleted },
    { label: 'Links', value: props.p.totals.links },
    { label: 'Files', value: props.p.totals.attachments },
  ];
  const tabs = (): Tab[] => [
    { id: 'channels', label: 'Where they post' },
    { id: 'links', label: 'Links' },
    ...(d() ? [{ id: 'servers' as const, label: 'Servers', count: d()!.mutualGuilds.length, title: 'Mutual servers' }] : []),
    ...(d()?.mutualFriendsCount ? [{ id: 'friends' as const, label: 'Friends', count: d()!.mutualFriendsCount, title: 'Mutual friends' }] : []),
  ];
  const pick = (id: TabId): void => {
    setTab(id);
    if (id === 'friends') showMutualFriends();
  };
  let main!: HTMLElement;
  /** What has scrolled this column: itself beside the rail, the window's columns when folded over it. */
  const scrollers = new Set<HTMLElement>();
  const [scrolled, setScrolled] = createSignal(false);
  onMount(() => {
    const read = (): void => void setScrolled([...scrollers].some((s) => scrolledFromTop(s) > 0));
    // Scroll events don't bubble: caught on the way down from the window.
    const root = main.closest('dialog') ?? document;
    const onScroll = (e: Event): void => {
      if (!(e.target instanceof HTMLElement) || !e.target.contains(main)) return;
      scrollers.add(e.target);
      read();
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // A resize can change which of them scrolls (the rail folds) without a scroll event.
    const resized = new ResizeObserver(read);
    resized.observe(main);
    onCleanup(() => {
      root.removeEventListener('scroll', onScroll, { capture: true });
      resized.disconnect();
    });
  });
  const toTop = (): void => scrollers.forEach((s) => s.scrollTo({ top: 0 }));
  const list = (rows: JSX.Element, empty: string, any: boolean, layout = styles.list) => (
    <Show when={any} fallback={<p class={`cp-hint ${styles.empty}`}>{empty}</p>}>
      <ul class={layout}>{rows}</ul>
    </Show>
  );
  return (
    <section class={styles.main} ref={main}>
      <div class={styles.archive}>
        <h3 class={styles.heading}>
          Archive
          <Show when={props.p.firstTs !== null && props.p.lastTs !== null}>
            <span class={styles.range}>
              {yearDate(props.p.firstTs!)} – {yearDate(props.p.lastTs!)}
            </span>
          </Show>
        </h3>
        <dl class={styles.stats}>
          <For each={stats()}>
            {(s) => (
              <div class={`${styles.stat} ${look.card}`}>
                <dt>{s.label}</dt>
                <dd>{figure(s.value)}</dd>
              </div>
            )}
          </For>
        </dl>
        <div class={styles.actions}>
          <button type="button" class="cp-button" onClick={() => search(byThem())}>
            Search their messages
          </button>
          <button type="button" class="cp-button" disabled={!props.p.totals.edited} onClick={() => search(`${byThem()} is:edited`)}>
            Edits
          </button>
          <button type="button" class="cp-button" disabled={!props.p.totals.deleted} onClick={() => search(`${byThem()} is:deleted`)}>
            Deletions
          </button>
        </div>
        <Show when={props.p.nicknames.length}>
          <p class={styles.nicknames}>
            Known as{' '}
            <For each={props.p.nicknames}>
              {(n, i) => (
                <>
                  {i() > 0 && ' · '}
                  {/* As Discord draws it in that server (role colour, font); opens their profile there. */}
                  <Show when={n.channelId} fallback={<span class={styles.nick}>{n.nick}</span>}>
                    {(place) => <PersonName userId={props.p.id} channelId={place()} fallback={n.nick} class={styles.nick} title={`Show their profile in ${n.guildName ?? 'that server'}`} />}
                  </Show>{' '}
                  in {n.guildName ?? 'a server'}
                </>
              )}
            </For>
          </p>
        </Show>
        <For each={personSections()}>
          {(section) => (
            <div class={styles.pluginSection}>
              <section.Component userId={props.p.id} />
            </div>
          )}
        </For>
      </div>
      <div class={styles.tabBar}>
        <div class={styles.tabs} role="tablist" aria-label="Profile sections">
          <For each={tabs()}>
            {(t) => (
              <button type="button" role="tab" class={styles.tab} title={t.title} aria-selected={tab() === t.id} onClick={() => pick(t.id)}>
                {t.label}
                <Show when={t.count !== undefined}>
                  <span class={styles.count}>{t.count}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        {/* Always laid out, so the tabs never move when it shows: hidden (and inert) at the top. */}
        <button type="button" class={`${styles.toTop} ${look.iconButton}`} aria-label="Back to top" title="Back to top" disabled={!scrolled()} onClick={toTop}>
          <Icon name="arrowUp" class={styles.toTopIcon} />
        </button>
      </div>
      <div class={styles.panel} role="tabpanel">
        <Switch>
          <Match when={tab() === 'channels'}>
            {list(
              <For each={props.p.channels}>
                {(c) => (
                  <li>
                    {/* Server icon (named in the tip), channel, their messages there, and when they last posted; behind it, a faint bar of its share of the busiest. */}
                    <button
                      type="button"
                      class={`${styles.place} ${look.row}`}
                      style={{ '--v': c.count / busiest() }}
                      title={c.guildName ? `#${c.channelName} · ${c.guildName}` : undefined}
                      onClick={() => void openArchive(c.channelId)}
                    >
                      <Show when={c.guildId} fallback={<span class={styles.placeless}><Icon name="person" /></span>}>
                        {(id) => <GuildIcon id={id()} name={c.guildName ?? ''} icon={c.guildIcon} />}
                      </Show>
                      <span class={styles.rowMain}>#{c.channelName}</span>
                      <span class={styles.placeCount}>
                        <span class={styles.placeFigure}>{figure(c.count)}</span> {c.count === 1 ? 'message' : 'messages'}
                      </span>
                      <span class={`${styles.placeLast} ${look.card}`} title={`Last posted there ${yearDate(c.lastTs)}`}>
                        {listAge(c.lastTs, now(), today())}
                      </span>
                    </button>
                  </li>
                )}
              </For>,
              'No archived messages from them.',
              props.p.channels.length > 0,
              styles.places,
            )}
          </Match>
          <Match when={tab() === 'links'}>
            {/* A plugin's view of their links (previews) when one is on; else the plain list. */}
            <Show
              when={personLinks()}
              fallback={list(
                <For each={props.p.links}>
                  {(l) => (
                    <li>
                      <button type="button" class={`${styles.row} ${look.row}`} title={l.url} onClick={() => void openArchive(l.channelId, l.messageId)}>
                        <span class={styles.rowMain}>{l.title ?? l.url}</span>
                        <span class={styles.rowMeta}>
                          {l.platform} · {shortDate(l.ts)}
                        </span>
                      </button>
                    </li>
                  )}
                </For>,
                'They haven’t shared links in the archive.',
                props.p.links.length > 0,
              )}
            >
              {(view) => <Dynamic component={view().Component} userId={props.p.id} />}
            </Show>
          </Match>
          <Match when={tab() === 'servers'}>
            {list(
              <For each={d()?.mutualGuilds ?? []}>
                {(g) => (
                  <li class={`${styles.row} ${styles.person}`}>
                    <GuildIcon id={g.id} name={g.name ?? ''} icon={g.icon} />
                    <span class={styles.personText}>
                      <span class={styles.rowMain}>{g.name ?? g.id}</span>
                      <Show when={g.nick}>{(n) => <span class={styles.rowMeta}>{n()}</span>}</Show>
                    </span>
                  </li>
                )}
              </For>,
              'No mutual servers.',
              (d()?.mutualGuilds.length ?? 0) > 0,
              styles.people,
            )}
          </Match>
          <Match when={tab() === 'friends'}>
            {list(
              <For each={mutualFriends.value()?.people ?? []}>
                {(f) => (
                  <li>
                    <button type="button" class={`${styles.row} ${styles.person} ${look.row}`} onClick={() => openPerson(f.id)}>
                      <img class={`${styles.friendAvatar} ${look.avatar}`} src={avatarUrl(f.id, f.avatar)} alt="" loading="lazy" />
                      <span class={styles.personText}>
                        <span class={styles.rowMain}>{f.name}</span>
                        <Show when={f.username}>{(u) => <span class={styles.rowMeta}>{u()}</span>}</Show>
                      </span>
                    </button>
                  </li>
                )}
              </For>,
              mutualFriends.loading() ? 'Loading…' : mutualFriends.stale() ? 'Discord couldn’t be reached.' : 'No mutual friends.',
              (mutualFriends.value()?.people.length ?? 0) > 0,
              styles.people,
            )}
          </Match>
        </Switch>
      </div>
    </section>
  );
}
