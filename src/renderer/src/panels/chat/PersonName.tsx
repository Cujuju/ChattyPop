// A person named outside a message (a summary, a list): their name as it shows in a place, kept current, opening their
// profile there.
import type { JSX } from 'solid-js';
import { openPerson } from '@/state/person';
import { personName } from '@/state/personNames';
import { AuthorName } from './AuthorName';

/** Drawn before core answers, or for someone it doesn't know. */
const UNKNOWN_PERSON = 'Unknown person';

/**
 * `userId`'s name as Discord draws it in `channelId` (null: no place), a button opening their profile there. `fallback`:
 * the name shown until core answers (a stored snapshot), else UNKNOWN_PERSON.
 */
export function PersonName(props: { userId: string; channelId: string | null; fallback?: string; class?: string; title?: string }): JSX.Element {
  const shown = () => personName(props.userId, props.channelId);
  const drawn = () => shown() ?? { name: props.fallback ?? UNKNOWN_PERSON, color: null, gradient: null, font: null };
  return (
    <AuthorName
      author={drawn()}
      class={props.class}
      title={props.title}
      // The place core read the name for: privacy mode may have withheld the one asked for.
      onClick={() => openPerson(props.userId, shown()?.channelId ?? null)}
    />
  );
}
