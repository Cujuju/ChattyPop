// A list's add action (Add account, New rule): an entry at its rail's foot. A narrow window shows it beside the picker instead.
import { Icon } from '@/ui/icons';
import styles from './SettingsLayout.module.css';

/** Adds an entry to a page's list. */
export interface RailAdd {
  label: string;
  onClick: () => void;
}

/** The add action's words on a button, where it is not a rail entry. */
export const railAddText = (add: RailAdd): string => `+ ${add.label}`;

/** The add action as the rail's last entry, under a rule. */
export function RailAddFoot(props: { add: RailAdd }) {
  return (
    <div class={styles.railFoot}>
      <hr class={styles.railDivider} />
      <div class="cp-rail-item">
        <button type="button" class={`cp-rail-button ${styles.railAdd}`} onClick={() => props.add.onClick()}>
          <Icon name="plus" class={styles.railAddIcon} />
          <span class="cp-rail-label">{props.add.label}</span>
        </button>
      </div>
    </div>
  );
}
