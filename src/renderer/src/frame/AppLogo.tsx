// The app icon at a title bar's left, as the system title bar showed it. The same file the installer and tray icons are drawn from.
import iconUrl from '../../../../build/icon.svg?url';

/** Decorative: the window title names the app. Its size is the bar's (`class`). */
export function AppLogo(props: { class: string | undefined }) {
  return <img class={props.class} src={iconUrl} alt="" draggable={false} />;
}
