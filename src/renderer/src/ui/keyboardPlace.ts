// A sheet in the keyboard's place (the phone's expression sheet): the height the keyboard had there, for the theme.
import { SHELL_KEYBOARD_PROPERTIES } from '@shared/shell';

/** The theme's --cp-keyboard-h (sizes.css reads it): the iPhone app's keyboard height as last seen raised. Unset until one has been, and in a browser, which doesn't publish it. */
const KEYBOARD_HEIGHT_PROPERTY = '--cp-keyboard-h';

/** Notes the raised keyboard's height (the inset the app last published on <html>), for a sheet about to take its place. */
export function noteKeyboardHeight(): void {
  const style = document.documentElement.style;
  const px = parseFloat(style.getPropertyValue(SHELL_KEYBOARD_PROPERTIES.inset)) || 0;
  if (px > 0) style.setProperty(KEYBOARD_HEIGHT_PROPERTY, `${px}px`);
}
