// A person named outside a message (a summary, a list, a picker): their avatar and their name as it shows in a place,
// kept current, opening their profile there.
import { Show, type JSX } from 'solid-js';
import { avatarUrl } from '@shared/media';
import { openPerson } from '@/state/person';
import { personName } from '@/state/personNames';
import { look } from '@/theme/look';
import type { SearchOption } from '@/ui/SearchSelect';
import { AuthorName, type DrawnName } from './AuthorName';
import styles from './PersonName.module.css';

/** Drawn before core answers, or for someone it doesn't know. */
const UNKNOWN_PERSON = 'Unknown person';

/** `userId`'s name as Discord draws it in `channelId` (null: no place); `fallback` (a stored snapshot) until core answers. */
const drawnName = (userId: string, channelId: string | null, fallback: string | undefined): DrawnName =>
  personName(userId, channelId) ?? { name: fallback ?? UNKNOWN_PERSON, color: null, gradient: null, font: null };

/**
 * `userId`'s name as Discord draws it in `channelId` (null: no place), a button opening their profile there. `fallback`:
 * the name shown until core answers (a stored snapshot), else UNKNOWN_PERSON.
 */
export function PersonName(props: { userId: string; channelId: string | null; fallback?: string; class?: string; title?: string }): JSX.Element {
  return (
    <AuthorName
      author={drawnName(props.userId, props.channelId, props.fallback)}
      class={props.class}
      title={props.title}
      // The place core read the name for: privacy mode may have withheld the one asked for.
      onClick={() => openPerson(props.userId, personName(props.userId, props.channelId)?.channelId ?? null)}
    />
  );
}

/** `userId`'s avatar, filling the box `class` sizes; its ground shows until core answers with the avatar. */
export function PersonFace(props: { userId: string; channelId: string | null; class?: string }): JSX.Element {
  const known = () => personName(props.userId, props.channelId);
  return (
    <Show when={known() !== undefined} fallback={<span class={`${styles.face} ${look.avatar} ${props.class ?? ''}`} aria-hidden="true" />}>
      <img class={`${styles.face} ${look.avatar} ${props.class ?? ''}`} src={avatarUrl(props.userId, known()?.avatar ?? null)} alt="" loading="lazy" />
    </Show>
  );
}

/** A picker's option for a person, as the Archive draws them: their avatar, then their styled name; `label` filters by it. */
export function personOption(o: { userId: string; channelId: string | null; fallback?: string; value?: string; note?: string }): SearchOption {
  return {
    value: o.value ?? o.userId,
    label: drawnName(o.userId, o.channelId, o.fallback).name,
    note: o.note,
    lead: () => <PersonFace userId={o.userId} channelId={o.channelId} />,
    name: () => <AuthorName author={drawnName(o.userId, o.channelId, o.fallback)} />,
  };
}
