// A name as Discord draws it: its colour (role colour or gradient in a server, Nitro colours outside one) in their Nitro
// name font, with a Nitro effect's hook; then, for an author, APP, their server tag and their role icon.
import { Show, createEffect, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { ArchiveMessage, PersonName } from '@shared/contract';
import { roleIconUrl, tagBadgeUrl } from '@shared/media';
import { ensureNameFont } from '@/ui/nameFonts';
import { hexColor } from './MessageExtras';
import { SolidIcon } from '@/ui/solidIcons';
import styles from './AuthorName.module.css';

/** What a drawn name needs; an author adds APP, the server tag and the role icon. */
export type DrawnName = Pick<PersonName, 'name' | 'color' | 'gradient' | 'font'> &
  Partial<Pick<PersonName, 'effect'> & Pick<ArchiveMessage['author'], 'app' | 'tag' | 'roleIcon'>>;

/** The name's colours as --role-color and --role-color-1..3 (a gradient's stops). */
function colorVars(a: DrawnName): JSX.CSSProperties | undefined {
  if (a.color === null) return undefined;
  const vars: JSX.CSSProperties = { '--role-color': hexColor(a.color) };
  a.gradient?.forEach((c, i) => (vars[`--role-color-${i + 1}`] = hexColor(c)));
  return vars;
}

/** The server tag a user shows beside their name: its badge and text, in Discord's chip. */
export function ServerTag(props: { tag: NonNullable<ArchiveMessage['author']['tag']> }) {
  return (
    <span class={styles.tag} title={`Server tag: ${props.tag.text}`}>
      <Show when={props.tag.badge}>{(b) => <img class={styles.badge} src={tagBadgeUrl(props.tag.guildId, b())} alt="" loading="lazy" />}</Show>
      {props.tag.text}
    </span>
  );
}

/** A button opening their profile; without `onClick`, plain text (a preview where nothing should open). */
export function AuthorName(props: { author: DrawnName; class?: string; title?: string; onClick?: () => void }) {
  const a = () => props.author;
  createEffect(() => {
    const font = a().font;
    if (font) ensureNameFont(font);
  });
  return (
    <Dynamic
      component={props.onClick ? 'button' : 'span'}
      type={props.onClick ? 'button' : undefined}
      class={`${props.class ?? ''} ${styles.name}`}
      data-role-color={a().color !== null}
      data-gradient={a().gradient?.length}
      style={colorVars(a())}
      title={props.title}
      onClick={() => props.onClick?.()}
    >
      <span class={styles.text} data-name-font={a().font?.key} data-name-effect={a().effect ?? undefined} data-text={a().name}>
        {a().name}
      </span>
      <Show when={a().app}>
        {(app) => (
          <span class={styles.app} title={app().verified ? 'Verified app' : undefined}>
            <Show when={app().verified}>
              <SolidIcon name="check" class={styles.check} />
            </Show>
            APP
          </span>
        )}
      </Show>
      <Show when={a().tag}>{(t) => <ServerTag tag={t()} />}</Show>
      <Show when={a().roleIcon}>
        {(r) => (
          <Show when={r().icon} fallback={<span class={styles.roleEmoji} role="img" aria-label={`Role icon, ${r().name}`}>{r().emoji}</span>}>
            {(icon) => <img class={styles.roleIcon} src={roleIconUrl(r().roleId, icon())} alt={`Role icon, ${r().name}`} title={r().name} loading="lazy" />}
          </Show>
        )}
      </Show>
    </Dynamic>
  );
}
