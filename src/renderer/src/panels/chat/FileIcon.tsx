// A file's type as Discord draws it on a file card: a page with a folded corner, tinted and marked by its kind.
import type { JSX } from 'solid-js';
import { FILE_KIND_LABEL, type FileKind } from '@shared/fileKinds';
import styles from './FileIcon.module.css';

/** The page and its fold on a 30×40 grid, the icon's own proportions. */
const PAGE = 'M4 1h16l9 9v26a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z';
const FOLD = 'M20 1v6a3 3 0 0 0 3 3h6';
const LINES = 'M8 18h14M8 23h14M8 28h9';

/** Each kind's mark on the page's lower part; an unknown file's page is blank. */
const GLYPHS: Readonly<Record<FileKind, () => JSX.Element>> = {
  image: () => (
    <>
      <path d="M7 18h16v14H7zM7 30l5-5 4 4 2-2 5 5" />
      <circle class={styles.solid} cx="19" cy="22" r="1.5" />
    </>
  ),
  video: () => <path class={styles.solid} d="M12 19v12l9-6z" />,
  audio: () => (
    <>
      <path d="M13 31V20l9-2v11" />
      <circle class={styles.solid} cx="11" cy="31" r="2" />
      <circle class={styles.solid} cx="20" cy="29" r="2" />
    </>
  ),
  // A zipper down the page from its top edge, its pull below.
  archive: () => <path d="M13 4h2M15 7h2M13 10h2M15 13h2M13 16h2M12.5 20h5v6a2.5 2.5 0 0 1-5 0z" />,
  // Discord's: a page of writing in Acrobat's red, set apart by its tint.
  pdf: () => <path d={LINES} />,
  document: () => <path d={LINES} />,
  spreadsheet: () => <path d="M7 18h16v14H7zM7 22.5h16M7 27h16M13 18v14" />,
  slides: () => <path d="M7 18h16v10H7zM15 28v4M11 32h8" />,
  code: () => <path d="M11 21l-4 4 4 4M19 21l4 4-4 4M16.5 19l-3 12" />,
  unknown: () => null,
};

/** Shows the kind, it isn't a control: the file's card or header is what acts. Sized and tinted by the theme. */
export function FileIcon(props: { kind: FileKind; class?: string }) {
  const label = () => `${FILE_KIND_LABEL[props.kind]} file`;
  return (
    <svg
      class={props.class ? `${styles.icon} ${props.class}` : styles.icon}
      data-kind={props.kind}
      viewBox="0 0 30 40"
      role="img"
      aria-label={label()}
    >
      <title>{label()}</title>
      <path class={styles.page} d={PAGE} />
      <path class={styles.fold} d={FOLD} />
      <g>{GLYPHS[props.kind]()}</g>
    </svg>
  );
}
