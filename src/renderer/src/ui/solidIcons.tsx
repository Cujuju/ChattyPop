// Named 24-unit solid icons for small standalone buttons, as Discord draws them: filled, details cut out (even-odd).
// They read at 1x where a 1px line icon (icons.tsx) is too faint.
import type { JSX } from 'solid-js';

/** Each icon's shapes on the 24-unit grid. */
const SOLID_ICONS = {
  addReaction: () => (
    <>
      <path d="M10 6a8 8 0 1 0 0 16 8 8 0 1 0 0-16ZM7.4 10.8a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 1 0 0-2.8ZM12.6 10.8a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 1 0 0-2.8ZM6.3 15.3h7.4a3.7 3.7 0 0 1-7.4 0Z" />
      <path d="M17.9 1.5h2.2v2.4h2.4v2.2h-2.4v2.4h-2.2V6.1h-2.4V3.9h2.4Z" />
    </>
  ),
  // Discord's verified mark (a verified app, a verified connection).
  check: () => <path d="M4 12.5l2.1-2.1 3.9 3.9 7.9-7.9 2.1 2.1-10 10z" />,
  // A camera, its lens cut out: the composer's in-app camera.
  camera: () => (
    <path d="M9 3h6l1.5 2H19a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h2.5ZM12 8.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9ZM12 10.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5Z" />
  ),
  attach: () => <path d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20ZM10.9 6.5h2.2v4.4h4.4v2.2h-4.4v4.4h-2.2v-4.4H6.5v-2.2h4.4Z" />,
  // Four tiles: the attach sheet's Apps (an app's commands).
  apps: () => <path d="M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />,
  // A page, its corner folded: the attach sheet's Files.
  file: () => <path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM13 3.5V9h5.5Z" />,
  // A picture, its sun and hill cut out: the attach sheet's Photos.
  image: () => <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8.5 6.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4ZM5 18h14l-4.5-6-3.5 4.5-2-2.5Z" />,
  // Three bars of votes: the attach sheet's Poll.
  poll: () => <path d="M3 4h12a2 2 0 0 1 0 4H3ZM3 10h18a2 2 0 0 1 0 4H3ZM3 16h8a2 2 0 0 1 0 4H3Z" />,
  // Two speech lines branching: the attach sheet's Thread.
  thread: () => <path d="M4 2h2.2v6.5a3 3 0 0 0 3 3H20v2.2H9.2A5.2 5.2 0 0 1 4 8.5ZM12 15.5h8v2.2h-8ZM12 19.8h6V22h-6Z" />,
  // Discord's mark, where Discord's profile shows it (the date someone joined Discord).
  discord: () => (
    <path d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 .96 17.7a18.43 18.43 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98-.65-.25-1.29-.55-1.9-.92.17-.12.32-.24.47-.37 3.58 1.7 7.7 1.7 11.28 0l.46.37c-.6.36-1.25.67-1.9.92.35.7.75 1.35 1.2 1.98 2.03-.63 3.94-1.6 5.64-2.87.47-4.87-.78-9.09-3.3-12.83ZM8.3 15.12c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.89 2.27-2 2.27Zm7.4 0c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.88 2.27-2 2.27Z" />
  ),
  // A pencil: Discord's Edit button.
  edit: () => (
    <>
      <path d="M3 17.2V21h3.8L17.4 10.4l-3.8-3.8Z" />
      <path d="M15 5.2l3.8 3.8 1.9-1.9a1.4 1.4 0 0 0 0-2l-1.8-1.8a1.4 1.4 0 0 0-2 0Z" />
    </>
  ),
  // An arrow into a tray: Discord's Download.
  download: () => <path d="M10.9 3h2.2v9.3l3.4-3.4 1.6 1.6L12 16.6l-6.1-6.1 1.6-1.6 3.4 3.4ZM3 16h2.2v3.8h13.6V16H21v6H3Z" />,
  emoji: () => (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20ZM8.8 8.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2ZM15.2 8.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2ZM7.4 13.6h9.2a4.6 4.6 0 0 1-9.2 0Z" />
  ),
  forward: () => <path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11Z" />,
  gif: () => (
    <path d="M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM4.75 8h5.5v1.8H6.55v4.4h1.9v-.9h-1v-1.7h2.8V16h-5.5ZM11.35 8h1.8v8h-1.8ZM14.25 8h5v1.8h-3.2v1.4h2.6V13h-2.6v3h-1.8Z" />
  ),
  // A speech bubble: Discord's Message button.
  message: () => <path d="M12 2a10 10 0 1 1 0 20H2.6l2.3-2.7A10 10 0 0 1 12 2Z" />,
  more: () => (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </>
  ),
  reply: () => <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11Z" />,
  // A bin with its lid: Discord's Delete.
  trash: () => <path d="M9 2h6l1 2h5v2H3V4h5ZM4.5 8h15l-1.3 12.2A2 2 0 0 1 16.2 22H7.8a2 2 0 0 1-2-1.8Z" />,
  send: () => <path d="M3.4 20.4 21 12 3.4 3.6V10l12 2-12 2Z" />,
  sticker: () => (
    <>
      <path d="M6 3h12a3 3 0 0 1 3 3v6h-5a4 4 0 0 0-4 4v5H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5Z" />
    </>
  ),
} satisfies Record<string, () => JSX.Element>;

export type SolidIconName = keyof typeof SOLID_ICONS;

/** A named solid icon, decorative (its button carries the label). 1em by default; `class` sets size and colour. */
export function SolidIcon(props: { name: SolidIconName; class?: string }) {
  return (
    <svg class={props.class ? `cp-icon ${props.class}` : 'cp-icon'} viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
      {SOLID_ICONS[props.name]()}
    </svg>
  );
}
