// Profile rails display banners/decorations, styled identity, badges, Message, biography, membership dates, roles, notes and connections.
import { For, Show, createEffect } from 'solid-js';
import type { DiscordProfile, PersonProfile } from '@shared/contract';
import { snowflakeToMs } from '@shared/discord';
import { avatarUrl, badgeUrl, bannerUrl, decorationUrl } from '@shared/media';
import { windowAudience } from '@/api';
import { messagePerson } from '@/state/newMessage';
import { isSelf } from '@/state/ownMessages';
import { postingUnlocked } from '@/state/posting';
import { failureNotice } from '@/state/dialogs';
import { closePerson, discordProfile } from '@/state/person';
import { ServerTag } from '@/panels/chat/AuthorName';
import { hexColor } from '@/panels/chat/MessageExtras';
import { shortDateTime, yearDate } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { Markdown } from '@/ui/Markdown';
import { SolidIcon } from '@/ui/solidIcons';
import { ensureNameFont } from '@/ui/nameFonts';
import { look } from '@/theme/look';
import styles from './ProfileCard.module.css';

/** Message opens the existing directory DM without requesting it. Hidden for phone/self/locked posting because it can create DMs. */
function message(userId: string): void {
  messagePerson(userId)
    .then(closePerson)
    .catch(failureNotice("Couldn't open the DM"));
}

export function ProfileCard(props: { p: PersonProfile }) {
  const d = (): DiscordProfile | null => discordProfile.value();
  const name = () => props.p.globalName ?? props.p.username ?? props.p.id;
  createEffect(() => {
    const font = props.p.style.font;
    if (font) ensureNameFont(font);
  });
  /** The server whose member fields show, as the profile lists it among mutual servers. */
  const guild = () => d()?.mutualGuilds.find((g) => g.id === d()?.guildId);
  return (
    <section class={styles.card} aria-label={`${name()}'s profile`}>
      <div class={styles.banner} style={d()?.accentColor != null ? { '--banner-color': hexColor(d()!.accentColor!) } : undefined}>
        <Show when={d()?.banner}>{(hash) => <img class={styles.bannerImage} src={bannerUrl(props.p.id, hash())} alt="" />}</Show>
      </div>
      <div class={styles.head}>
        <div class={styles.avatarStack}>
          <img class={`${styles.avatar} ${look.avatar}`} src={avatarUrl(props.p.id, props.p.avatar, true)} alt="" />
          <Show when={props.p.style.decoration}>
            {(asset) => <img class={styles.decoration} src={decorationUrl(asset(), true, true)} alt="" aria-hidden="true" />}
          </Show>
        </div>
        <div class={styles.identity}>
          <h2 class={styles.name} data-name-font={props.p.style.font?.key}>
            {name()}
          </h2>
          <div class={styles.userRow}>
            <Show when={props.p.username}>{(u) => <span class={styles.username}>{u()}</span>}</Show>
            <Show when={d()?.pronouns}>{(pr) => <span class={styles.pronouns}>{pr()}</span>}</Show>
            <Show when={props.p.style.tag}>{(t) => <ServerTag tag={t()} />}</Show>
            <For each={d()?.badges ?? []}>
              {(b) => <img class={styles.badge} src={badgeUrl(b.icon)} alt={b.description} title={b.description} />}
            </For>
          </div>
        </div>
      </div>
      <Show when={windowAudience() === 'renderer' && !isSelf(props.p.id) && postingUnlocked()}>
        <div class={styles.actions}>
          <button type="button" class={`${styles.messageButton} ${look.button}`} data-variant="primary" onClick={() => message(props.p.id)}>
            <SolidIcon name="message" class={styles.buttonIcon} />
            Message
          </button>
        </div>
      </Show>
      <div class={styles.details}>
        <Show when={d()?.bio}>
          {(bio) => (
            <div class={`${styles.bio} ${styles.wide}`}>
              <Markdown text={bio()} />
            </div>
          )}
        </Show>
        <div class={styles.section}>
          <h3 class={styles.label}>Member Since</h3>
          <p class={styles.since}>
            <span class={styles.sinceItem} title="Joined Discord">
              <SolidIcon name="discord" class={styles.sinceIcon} />
              {yearDate(snowflakeToMs(props.p.id))}
            </span>
            <Show when={d()?.joinedAt != null && guild()}>
              {(g) => (
                <>
                  <span class={styles.dot} aria-hidden="true">•</span>
                  <span class={`${styles.sinceItem} ${styles.sinceGuild}`} title={`Joined ${g().name ?? 'the server'}`}>
                    <GuildIcon id={g().id} name={g().name ?? ''} icon={g().icon} />
                    {yearDate(d()!.joinedAt!)}
                  </span>
                </>
              )}
            </Show>
          </p>
        </div>
        <Show when={d()?.friendsSince}>
          {(since) => (
            <div class={styles.section}>
              <h3 class={styles.label}>Friends Since</h3>
              <p class={styles.value}>{yearDate(since())}</p>
            </div>
          )}
        </Show>
        <Show when={d()?.roles.length}>
          <div class={`${styles.section} ${styles.wide}`}>
            <h3 class={styles.label}>Roles</h3>
            <ul class={styles.roles}>
              <For each={d()!.roles}>
                {(r) => (
                  <li class={styles.role} style={r.color !== null ? { '--role-color': hexColor(r.color) } : undefined} data-role-color={r.color !== null}>
                    <span class={styles.roleDot} aria-hidden="true" />
                    {r.name}
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={d()?.note}>
          {(note) => (
            <div class={`${styles.section} ${styles.wide}`}>
              <h3 class={styles.label}>Note (only visible to you)</h3>
              <p class={styles.value}>{note()}</p>
            </div>
          )}
        </Show>
        <Show when={d()?.connections.length}>
          <div class={`${styles.section} ${styles.wide}`}>
            <h3 class={styles.label}>Connections</h3>
            <ul class={styles.connections}>
              <For each={d()!.connections}>
                {(c) => (
                  <li class={styles.connection}>
                    <span class={styles.platform}>{c.type}</span>
                    {c.name}
                    <Show when={c.verified}>
                      <span class={styles.verified} title="Verified">
                        <SolidIcon name="check" />
                        <span class="cp-visually-hidden">Verified</span>
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={discordProfile.stale()}>
          <p class={`${styles.stale} ${styles.wide}`} role="status">
            {d() ? `Discord couldn't be reached; showing its profile as of ${shortDateTime(d()!.fetchedAt)}.` : "Discord couldn't be reached; its profile isn't shown."}
          </p>
        </Show>
      </div>
    </section>
  );
}
