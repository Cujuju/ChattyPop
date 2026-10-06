// Named 24-unit line icons use base.css strokes/default 1em sizing; callers resize. Small standalone buttons use solidIcons.
import type { JSX } from 'solid-js';
import type { IconName } from './iconNames';

export type { IconName };

const GEAR =
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';

/** Each icon's shapes on the 24-unit grid; section icons and settings tabs reuse them. */
export const ICON_SHAPES = {
  // A person with a plus: add someone.
  addPerson: () => (
    <>
      <circle cx="10" cy="8" r="4" />
      <path d="M3 21a7 7 0 0 1 14 0M19 8v6M16 11h6" />
    </>
  ),
  addReaction: () => (
    <>
      <circle cx="11" cy="13" r="8" />
      <path d="M8 15a4 4 0 0 0 6 0M19 2v5M16.5 4.5h5" />
      {/* Filled eyes: a stroked dot is a 1px speck at menu size. */}
      <circle cx="8.5" cy="10.5" r="1.25" fill="currentColor" />
      <circle cx="13.5" cy="10.5" r="1.25" fill="currentColor" />
    </>
  ),
  archive: () => <path d="M4 4h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />,
  arrowDown: () => <path d="M12 5v14M6 13l6 6 6-6" />,
  arrowUp: () => <path d="M12 19V5M6 11l6-6 6 6" />,
  bell: () => <path d="M6 9a6 6 0 0 1 12 0v4l2 4H4l2-4zM10 20a2 2 0 0 0 4 0" />,
  // A bell struck through: muted.
  bellOff: () => <path d="M6 9a6 6 0 0 1 12 0v4l2 4H4l2-4zM10 20a2 2 0 0 0 4 0M3 3l18 18" />,
  check: () => <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevronLeft: () => <path d="M15 6l-6 6 6 6" />,
  chevronRight: () => <path d="M9 6l6 6-6 6" />,
  chevronsLeft: () => <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />,
  chevronsRight: () => <path d="M5 6l6 6-6 6M13 6l6 6-6 6" />,
  clock: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: () => <path d="M6 6l12 12M18 6 6 18" />,
  // A pen over a page: start a new message.
  compose: () => <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />,
  compress: () => <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  conversation: () => <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.6A8 8 0 1 1 20.5 11.5z" />,
  copy: () => (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  cpu: () => (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  // A group's owner, as Discord marks them.
  crown: () => <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" />,
  edit: () => <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  // A box with an arrow leaving it: opens outside the app.
  // A plain smiley: the standard emoji.
  emoji: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
      <circle cx="9" cy="10" r="1.25" fill="currentColor" />
      <circle cx="15" cy="10" r="1.25" fill="currentColor" />
    </>
  ),
  external: () => <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  eye: () => (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: () => (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M4 4l16 16" />
    </>
  ),
  // A funnel of three shortening lines: a filter.
  filter: () => <path d="M4 7h16M7 12h10M10 17h4" />,
  forward: () => <path d="M15 17l5-5-5-5M20 12H9a5 5 0 0 0-5 5v1" />,
  group: () => (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  // An ID card: a '#' reads as a channel.
  id: () => <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 9v6M11.5 9v6h1.5a3 3 0 0 0 0-6z" />,
  image: () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  jev: () => <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16v5M16.5 18.5h5" />,
  // A door with an arrow out: leave a group.
  leave: () => <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h11M17 8l4 4-4 4" />,
  lock: () => (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  link: () => <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  more: () => (
    <>
      {/* Filled: stroked rings read as hollow specks at menu size. */}
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  person: () => (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  plus: () => <path d="M12 5v14M5 12h14" />,
  reply: () => <path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v1" />,
  search: () => (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  settings: () => (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // Filled by its caller's CSS when on (a saved search).
  star: () => <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  summary: () => <path d="M4 6h16M4 10h16M4 14h10M4 18h6" />,
  swap: () => <path d="M7 4 3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />,
  tag: () => (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  text: () => <path d="M4 6h16M4 12h16M4 18h10" />,
  trash: () => <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />,
  undo: () => <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  waveform: () => <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />,
  window: () => (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
} satisfies Record<IconName, () => JSX.Element>;

/** A named line icon, decorative (its button or row carries the label). 1em by default; `class` sets size and colour. */
export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg class={props.class ? `cp-icon ${props.class}` : 'cp-icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {ICON_SHAPES[props.name]()}
    </svg>
  );
}
