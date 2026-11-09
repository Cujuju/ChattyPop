// The connect page's own title bar when its window is frameless (WindowBar). The page is otherwise plain DOM.
import { render } from 'solid-js/web';
import type { WindowControls } from '@shared/windowControls';
import { WindowBar } from '../frame/WindowBar';
import { Contained } from '../ui/contained';

/** Draws the window's title bar into `host`, titled as the page. */
export function mountWindowBar(host: HTMLElement, controls: WindowControls): void {
  render(() => <Contained name="The title bar" shows="line"><WindowBar controls={controls} title={document.title} /></Contained>, host);
}
