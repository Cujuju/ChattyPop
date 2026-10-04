// Settings → Desktop → Shortcuts: the show/hide shortcut, the leader key and each shortcut's key, captured from the next key press.
// Capture modelled on StockApp's ShortcutHelpOverlay: Escape cancels, a lone modifier keeps listening, a conflict is refused.
import { For, Show, createSignal } from 'solid-js';
import { bundledPlugin } from '@shared/bundledPlugins';
import { hotkeyLabel, hotkeyOf } from '@shared/desktop';
import { desktopState, patchDesktopSettings } from '@/state/desktop';
import { DEFAULT_LEADER_KEY, MODIFIER_KEYS, keyLabel } from '@/state/leaderRules';
import { pluginActive } from '@/state/plugins';
import { LAYOUT_KEYS, LAYOUT_NAME, leaderRefusal, rebindRefusal, shadowedBindings, withBinding, type ShortcutDef } from '@/state/shortcutBindings';
import { SHORTCUT_DEFS, bindingOverrides, bindings, leaderKey, setBindingOverrides, setLeaderKey } from '@/state/shortcuts';
import { Icon } from '@/ui/icons';
import { Note, Row, SettingsButton } from './SettingsLayout';
import styles from './ShortcutKeys.module.css';

const CHORD_REFUSAL = 'Shortcuts take one key, without Ctrl, Alt or Win.';
const chord = (e: KeyboardEvent): boolean => e.ctrlKey || e.altKey || e.metaKey;

/** The system-wide show/hide shortcut: the next key press with Ctrl, Alt or Win held; Backspace or Delete clears it. */
export function HotkeyRow() {
  const hotkey = (): string | null => desktopState()?.settings.hotkey ?? null;
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') void patchDesktopSettings({ hotkey: null });
    const next = hotkeyOf(e);
    if (next) void patchDesktopSettings({ hotkey: next });
  };
  return (
    <Row
      label="Show or hide ChattyPop"
      for="desktop-hotkey"
      hint="From any app. Needs Ctrl, Alt or Win."
      control={
        <div class={styles.keyControl}>
          <input id="desktop-hotkey" readOnly placeholder="Press a shortcut" value={hotkey() ? hotkeyLabel(hotkey()!) : ''} disabled={!desktopState()} onKeyDown={onKeyDown} />
          <SettingsButton disabled={!hotkey()} onClick={() => void patchDesktopSettings({ hotkey: null })}>
            Clear
          </SettingsButton>
        </div>
      }
    >
      <Show when={desktopState()?.hotkeyTaken && desktopState()?.settings.hotkey}>
        {(taken) => <Note kind="error">Another app uses {hotkeyLabel(taken())}.</Note>}
      </Show>
    </Row>
  );
}

/**
 * A key's field: click it (or press Enter on it), then press the new key; Escape or leaving it cancels. `take` binds
 * the key or returns why not; a refused key keeps it listening.
 */
function KeyField(props: { id: string; class?: string; value: string; placeholder: string; take: (key: string) => string | null; setRefusal: (reason: string | null) => void }) {
  const [listening, setListening] = createSignal(false);
  const stop = (): void => {
    setListening(false);
    props.setRefusal(null);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!listening()) {
      if (e.key === 'Enter') {
        e.preventDefault();
        setListening(true);
      }
      return;
    }
    // Listening takes every key, Tab and Escape included, so no window or dialog handler sees it.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if (MODIFIER_KEYS.has(e.key)) return;
    const reason = chord(e) ? CHORD_REFUSAL : props.take(e.key);
    props.setRefusal(reason);
    if (!reason) setListening(false);
  };
  return (
    <input
      id={props.id}
      class={props.class}
      readOnly
      placeholder={props.placeholder}
      value={listening() ? '' : props.value}
      onClick={() => setListening(true)}
      onBlur={stop}
      onKeyDown={onKeyDown}
    />
  );
}

/** The key pressed before every shortcut: Space or a symbol no shortcut takes. */
export function LeaderKeyRow() {
  const [refusal, setRefusal] = createSignal<string | null>(null);
  /** Makes `key` the leader unless refused; returns why not. */
  const take = (key: string): string | null => {
    const reason = leaderRefusal(key, bindings());
    if (!reason) void setLeaderKey(key);
    return reason;
  };
  return (
    <Row
      label="Leader key"
      for="desktop-leader-key"
      hint="Press it, then a key below. Off while typing."
      control={
        <div class={styles.keyControl}>
          <KeyField id="desktop-leader-key" value={keyLabel(leaderKey())} placeholder="Press Space or a symbol" take={take} setRefusal={setRefusal} />
          <SettingsButton disabled={leaderKey() === DEFAULT_LEADER_KEY} title={`Reset to ${keyLabel(DEFAULT_LEADER_KEY)}`} onClick={() => setRefusal(take(DEFAULT_LEADER_KEY))}>
            Default
          </SettingsButton>
        </div>
      }
    >
      <Show when={refusal()}>{(r) => <Note kind="error">{r()}</Note>}</Show>
    </Row>
  );
}

/** The plugin a shortcut comes from, beside its name; null for the host's. */
function origin(def: ShortcutDef): string | null {
  if (!def.plugin) return null;
  const name = bundledPlugin(def.plugin.id)?.manifest.name ?? def.plugin.id;
  return pluginActive(def.plugin.id) ? name : `${name} (off)`;
}

/** One shortcut's key on one line, with a reset once it differs from its default. */
function BindingKey(props: { def: ShortcutDef }) {
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const current = (): string => bindings().find((b) => b.id === props.def.id)?.key ?? '';
  const overridden = (): boolean => bindingOverrides()[props.def.id] !== undefined;
  const shadow = () => shadowedBindings(bindings()).get(props.def.id);
  /** Binds `key` (null: the default) unless refused; returns why not. */
  const take = (key: string | null): string | null => {
    const reason = rebindRefusal(props.def.id, key ?? props.def.defaultKey ?? leaderKey(), bindings(), leaderKey());
    if (!reason) void setBindingOverrides(withBinding(bindingOverrides(), props.def, key, leaderKey()));
    return reason;
  };
  const inputId = (): string => `shortcut-key-${props.def.id}`;
  const resetLabel = (): string => `Reset to ${props.def.defaultKey === null ? 'the leader again' : keyLabel(props.def.defaultKey)}`;
  return (
    <li class={styles.key}>
      <label class={styles.keyName} for={inputId()}>
        {props.def.name}
        <Show when={origin(props.def)}>{(o) => <span class={styles.keyOrigin}>{o()}</span>}</Show>
      </label>
      <Show when={overridden()}>
        <button type="button" class={styles.keyReset} aria-label={resetLabel()} title={resetLabel()} onClick={() => setRefusal(take(null))}>
          <Icon name="undo" />
        </button>
      </Show>
      <KeyField id={inputId()} class={styles.keyField} value={keyLabel(current())} placeholder="Press a key" take={take} setRefusal={setRefusal} />
      <Show when={refusal()}>{(r) => <Note kind="error">{r()}</Note>}</Show>
      <Show when={shadow()}>
        {(other) => <Note kind="error">{`${keyLabel(current())} runs “${other().name}” first; choose another key.`}</Note>}
      </Show>
    </li>
  );
}

/** Every shortcut on a line of its own, in columns: the fixed layout digits, the host's, then plugins' (on or off). */
export function ShortcutKeyList() {
  return (
    <div class={styles.keys}>
      <p class={styles.keysHint}>Click a key to change it.</p>
      <ul class={styles.keyList}>
        <li class={styles.key}>
          <span class={styles.keyName}>
            {LAYOUT_NAME}
            <span class={styles.keyOrigin}>top bar order</span>
          </span>
          <kbd class={styles.keyFixed}>{`${LAYOUT_KEYS[0]}–${LAYOUT_KEYS.at(-1)}`}</kbd>
        </li>
        <For each={SHORTCUT_DEFS}>{(def) => <BindingKey def={def} />}</For>
      </ul>
    </div>
  );
}
