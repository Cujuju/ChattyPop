// One person: their Discord profile as a rail beside the archive's view of them (ProfileCard, PersonTabs).
// Right-click a message → View, or click an author. No AI.
import { Show } from 'solid-js';
import { closePerson, person, personId } from '@/state/person';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import chrome from '@/ui/WindowChrome.module.css';
import { PersonTabs } from './PersonTabs';
import { ProfileCard } from './ProfileCard';
import styles from './PersonView.module.css';

export function PersonView() {
  return (
    <FloatingWindow id="person" open={personId() !== null} class={chrome.dialog} aria-label="Person" onClose={closePerson}>
      <WindowHeader title="Person" classes={chrome} closeLabel="Close" onClose={closePerson} />
      <div class={`${chrome.body} ${styles.body}`}>
        <Show when={person.error}>
          <p class={`cp-error ${styles.notice}`} role="alert">
            Couldn't load this person.
          </p>
        </Show>
        <Show when={!person.loading && person() === null}>
          <p class={`cp-hint ${styles.notice}`}>This person isn't in the archive.</p>
        </Show>
        <Show when={person()}>
          {(p) => (
            <div class={styles.columns}>
              <ProfileCard p={p()} />
              <PersonTabs p={p()} />
            </div>
          )}
        </Show>
      </div>
    </FloatingWindow>
  );
}
