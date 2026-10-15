// The strip over the Archive's log in select mode: how many are ticked, what can be done with them, and leaving.
import { For } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { HOST_SELECTION_MENU_ITEMS } from '@shared/anchors';
import type { HostSelectionMenuItem } from '@/plugins/readSlots';
import { selectionMenuItems } from '@/plugins/slots';
import { failureNotice } from '@/state/dialogs';
import { selectedMessages, stopSelecting } from '@/state/messageSelection';
import { overlayOpen } from '@/state/overlay';
import { openMenuAt } from '@/state/ui';
import { countText, shortDateTime } from '@/ui/format';
import { Icon } from '@/ui/icons';
import { listen } from '@/ui/listen';
import type { MenuItem } from '@/ui/menuTypes';
import styles from '@/ui/LogParts.module.css';

/** The messages as lines of text: when, who, what was said. */
export const selectionText = (messages: readonly ArchiveMessage[]): string =>
  messages.map((m) => `[${shortDateTime(m.ts)}] ${m.author.name}: ${m.content}`).join('\n');

/** The host's actions, at their anchors: Copy text when any selected message has text. */
const HOST_ITEMS: readonly HostSelectionMenuItem[] = HOST_SELECTION_MENU_ITEMS.map((id) => ({
  id,
  item: (messages) =>
    messages.some((m) => m.content)
      ? { label: 'Copy text', icon: 'copy', run: () => navigator.clipboard.writeText(selectionText(messages)).catch(failureNotice("Couldn't copy the messages")) }
      : null,
}));

/** Shown in select mode. Escape leaves it unless something lies over the chat (a menu closes first). */
export function SelectionBar() {
  listen(window, 'keydown', (e) => {
    if (e.key === 'Escape' && !overlayOpen()) stopSelecting();
  });
  const act = (item: MenuItem, button: HTMLButtonElement): void => {
    if (item.submenu) openMenuAt(button, item.submenu);
    else void item.run();
  };
  return (
    // Overlay pinned to the top of the scroll area, in the unread strip's place; the look is in LogParts.module.css.
    <div class={styles.unreadBanner} role="toolbar" aria-label="Selected messages" style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
      <span class={styles.selectionCount} role="status">
        {selectedMessages().length ? `${countText(selectedMessages().length, 'message')} selected` : 'Click messages to select them; Shift-click for a range'}
      </span>
      {/* Actions are asked only about a selection of one or more. */}
      <For each={selectedMessages().length ? selectionMenuItems(selectedMessages(), HOST_ITEMS) : []}>
        {(item) => (
          <button type="button" class={styles.selectionAction} aria-haspopup={item.submenu ? 'menu' : undefined} onClick={(e) => act(item, e.currentTarget)}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        )}
      </For>
      <button type="button" class={styles.unreadDismiss} aria-label="Leave select mode" title="Leave select mode (Esc)" onClick={stopSelecting}>
        <Icon name="close" />
      </button>
    </div>
  );
}
