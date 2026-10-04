import { searchOpen } from './search';
import { contextMenu, draggedPanel, lightbox, resizing } from './ui';

// Its own module: ui.ts holds plain signals with no store imports, so stores (search → preferences → ui) can't cycle.

/** True while the native Discord view must be hidden (renderer UI above or across the chat area). Floating windows hide it only where they overlap it (state/windows). */
export const overlayOpen = (): boolean =>
  resizing() || draggedPanel() !== null || lightbox() !== null || contextMenu() !== null || searchOpen();
