// Reports workspace interactions the toolkit draws but has no callback for, so the native Discord view hides under them.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { setDockMenuOpen, setResizing } from '@/state/ui';

/** The toolkit's divider and centre-drop menu classes (its styling hooks). */
const HANDLE_SELECTOR = '.twm-handle';
const DOCK_MENU_SELECTOR = ':scope > .twm-dock-menu';

/** Call with the TilingWorkspace's root element. Divider drags set `resizing`; the Swap/Tab menu sets `dockMenuOpen`. */
export function watchWorkspaceActivity(workspace: HTMLElement): void {
  const endResize = (): void => {
    setResizing(false);
    window.removeEventListener('pointerup', endResize, true);
    window.removeEventListener('pointercancel', endResize, true);
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (!(e.target as Element | null)?.closest?.(HANDLE_SELECTOR)) return;
    setResizing(true);
    window.addEventListener('pointerup', endResize, true);
    window.addEventListener('pointercancel', endResize, true);
  };
  workspace.addEventListener('pointerdown', onPointerDown, true);
  // The menu mounts as the workspace's direct child; watching only direct children keeps panel content out of it.
  const menus = new MutationObserver(() => void setDockMenuOpen(workspace.querySelector(DOCK_MENU_SELECTOR) !== null));
  menus.observe(workspace, { childList: true });
  onCleanup(() => {
    workspace.removeEventListener('pointerdown', onPointerDown, true);
    menus.disconnect();
    endResize();
    setDockMenuOpen(false);
  });
}
