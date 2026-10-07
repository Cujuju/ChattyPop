import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { BUTTON_STYLE, COMPONENT, MESSAGE_FLAG, type ComponentEmoji, type MediaItem, type MessageComponent } from '@shared/components';
import type { ArchiveInteraction, ArchiveMessage } from '@shared/contract';
import { EmojiImage } from '@/ui/AnimatedImage';
import { proxiedUrl, thumbUrl } from '@shared/media';
import { channelById } from '@/state/directory';
import { componentPending, useMessageComponent, type EntityChoice } from '@/state/commands';
import { postingUnlocked } from '@/state/posting';
import { setLightbox } from '@/state/ui';
import { createAction, type Action } from '@/ui/action';
import { Markdown } from '@/ui/Markdown';
import { Select } from '@/ui/Select';
import { EntityPicker } from './EntityPicker';
import { hexColor, mediaSizeVars } from './MessageExtras';
import { Icon } from '@/ui/icons';
import styles from './Components.module.css';

type SelectMenu = Extract<MessageComponent, { type: 'select' }>;
/** Gallery images per row, as Discord lays them out. */
const GALLERY_COLUMNS_MAX = 3;
const BUTTON_STYLE_NAMES: Record<number, string> = {
  [BUTTON_STYLE.primary]: 'primary',
  [BUTTON_STYLE.secondary]: 'secondary',
  [BUTTON_STYLE.success]: 'success',
  [BUTTON_STYLE.danger]: 'danger',
  [BUTTON_STYLE.link]: 'link',
  [BUTTON_STYLE.premium]: 'secondary',
};

/** "Ann used /roll" above an app's reply to a command. */
export function InteractionLine(props: { interaction: ArchiveInteraction }) {
  return (
    <p class={styles.interaction}>
      <span class={styles.interactionUser}>{props.interaction.userName}</span> used{' '}
      <span class={styles.interactionCommand}>/{props.interaction.command ?? 'a command'}</span>
    </p>
  );
}

/** An app's still-thinking note, its buttons, menus and layout blocks, and the only-you-can-see-this mark. Read-only while posting is locked. */
export function MessageComponents(props: { message: ArchiveMessage }) {
  const m = () => props.message;
  // Serializes message component actions and displays busy/errors. Busy state survives virtual-row recreation while previous actions remain pending.
  const own = createAction();
  const action: Action = { ...own, busy: () => own.busy() || componentPending(m().id) };
  return (
    <>
      <Show when={m().flags & MESSAGE_FLAG.loading && !m().content}>
        <p class={styles.thinking}>{m().author.name} is thinking…</p>
      </Show>
      <Show when={m().components.length}>
        <div class={styles.root} data-busy={action.busy()}>
          <Blocks items={m().components} message={m()} action={action} />
        </div>
      </Show>
      <Show when={action.error()}>
        <p class="cp-error" role="alert">
          {action.error()}
        </p>
      </Show>
      <Show when={m().flags & MESSAGE_FLAG.ephemeral}>
        <p class={styles.ephemeral}>Only you can see this</p>
      </Show>
    </>
  );
}

function Blocks(props: { items: MessageComponent[]; message: ArchiveMessage; action: Action }) {
  return <For each={props.items}>{(c) => <Block c={c} message={props.message} action={props.action} />}</For>;
}

/** Updates are reconciled in place, so a component can keep its object while its type changes: dispatch again on type. */
function Block(props: { c: MessageComponent; message: ArchiveMessage; action: Action }) {
  return (
    <Show when={props.c.type} keyed>
      {(_type) => <BlockOfType c={props.c} message={props.message} action={props.action} />}
    </Show>
  );
}

function BlockOfType(props: { c: MessageComponent; message: ArchiveMessage; action: Action }) {
  const c = props.c;
  switch (c.type) {
    case 'row':
      return (
        <div class={styles.row}>
          <Blocks items={c.children} message={props.message} action={props.action} />
        </div>
      );
    case 'button':
      return <ComponentButton button={c} message={props.message} action={props.action} />;
    case 'select':
      return <ComponentSelect select={c} message={props.message} action={props.action} />;
    case 'text':
      return (
        <div class={styles.text}>
          <Markdown text={c.content} mentions={props.message.mentions} />
        </div>
      );
    case 'section':
      return (
        <div class={styles.section}>
          <div class={styles.sectionBody}>
            <Blocks items={c.children} message={props.message} action={props.action} />
          </div>
          <Show when={c.accessory}>{(a) => <Block c={a()} message={props.message} action={props.action} />}</Show>
        </div>
      );
    case 'thumbnail':
      return <MediaImage media={c.media} class={styles.thumb} />;
    case 'gallery':
      return (
        <div class={styles.gallery} data-count={Math.min(c.items.length, GALLERY_COLUMNS_MAX)}>
          <For each={c.items}>{(i) => <MediaImage media={i} class={styles.galleryItem} />}</For>
        </div>
      );
    case 'file':
      return (
        <a class={styles.file} href={c.url} target="_blank" rel="noreferrer">
          {c.name}
        </a>
      );
    case 'separator':
      return <hr class={styles.separator} data-divider={c.divider} data-large={c.large} />;
    case 'container':
      return (
        <div class={styles.container} style={c.color !== null ? { '--component-accent': hexColor(c.color) } : {}}>
          <Blocks items={c.children} message={props.message} action={props.action} />
        </div>
      );
  }
}

function MediaImage(props: { media: MediaItem; class: string | undefined }) {
  const m = () => props.media;
  return (
    <button
      type="button"
      class={`${styles.mediaButton} ${props.class ?? ''}`}
      aria-label="Open image"
      onClick={() => setLightbox({ src: proxiedUrl(m().url), alt: m().description ?? '', caption: m().description ?? 'Image', originalUrl: m().url })}
    >
      <img class={styles.media} data-sized={m().size !== null} style={mediaSizeVars(m().size)} src={thumbUrl(m().url)} alt={m().description ?? ''} loading="lazy" />
    </button>
  );
}

function Emoji(props: { emoji: ComponentEmoji }) {
  return (
    <Show when={props.emoji.id} fallback={<span class={styles.emoji}>{props.emoji.name}</span>}>
      {(id) => <EmojiImage class={styles.emoji} emoji={{ id: id(), animated: props.emoji.animated }} alt={`:${props.emoji.name}:`} />}
    </Show>
  );
}

function ComponentButton(props: { button: Extract<MessageComponent, { type: 'button' }>; message: ArchiveMessage; action: Action }) {
  const b = props.button;
  const inner = (
    <>
      <Show when={b.emoji}>{(e) => <Emoji emoji={e()} />}</Show>
      <Show when={b.label}>{(l) => <span>{l()}</span>}</Show>
    </>
  );
  return (
    <Show
      when={b.style === BUTTON_STYLE.link && b.url}
      fallback={
        <button
          type="button"
          class={styles.button}
          data-style={BUTTON_STYLE_NAMES[b.style] ?? 'secondary'}
          disabled={b.disabled || !b.customId || props.action.busy() || props.message.deletedAt !== null || !postingUnlocked()}
          onClick={() => void props.action.run(() => useMessageComponent(props.message, COMPONENT.button, b.customId!))}
        >
          {inner}
        </button>
      }
    >
      {(url) => (
        // Disabled: no href, so it neither opens nor takes focus.
        <a class={styles.button} data-style="link" href={b.disabled ? undefined : url()} target="_blank" rel="noreferrer" aria-disabled={b.disabled}>
          {inner}
          <Icon name="external" />
        </a>
      )}
    </Show>
  );
}

/** A select menu: the app's options, or people, roles or channels of the server; picks reach the app once chosen. */
function ComponentSelect(props: { select: SelectMenu; message: ArchiveMessage; action: Action }) {
  const s = props.select;
  const disabled = (): boolean => s.disabled || props.action.busy() || props.message.deletedAt !== null || !postingUnlocked();
  const send = (values: string[]): void => void props.action.run(() => useMessageComponent(props.message, s.componentType, s.customId, values));
  return (
    <Show when={s.kind !== 'string'} fallback={<StringSelect select={s} disabled={disabled()} onSend={send} />}>
      <EntitySelect select={s} message={props.message} disabled={disabled()} onSend={send} />
    </Show>
  );
}

function StringSelect(props: { select: SelectMenu; disabled: boolean; onSend: (values: string[]) => void }) {
  const s = props.select;
  const [picked, setChosen] = createSignal<string[]>(s.options.filter((o) => o.selected).map((o) => o.value));
  // The app's update can drop options: only ones it still offers count as chosen.
  const chosen = (): string[] => picked().filter((v) => s.options.some((o) => o.value === v));
  return (
    <Switch>
      <Match when={s.maxValues <= 1}>
        <Select
          class={styles.select}
          disabled={props.disabled}
          value={chosen()[0] ?? ''}
          options={[{ value: '', label: s.placeholder ?? 'Make a selection' }, ...s.options.map((o) => ({ value: o.value, label: o.label }))]}
          onChange={(v) => {
            // The placeholder clears the choice, when the app allows none.
            if (!v && (s.minValues > 0 || !chosen().length)) return;
            setChosen(v ? [v] : []);
            props.onSend(v ? [v] : []);
          }}
        />
      </Match>
      <Match when={s.maxValues > 1}>
        <fieldset class={styles.multi} disabled={props.disabled}>
          <legend class={styles.multiLegend}>{s.placeholder ?? `Choose up to ${s.maxValues}`}</legend>
          <For each={s.options}>
            {(o) => (
              <label class="cp-check">
                <input
                  type="checkbox"
                  checked={chosen().includes(o.value)}
                  disabled={!chosen().includes(o.value) && chosen().length >= s.maxValues}
                  onChange={(e) => setChosen((c) => (e.currentTarget.checked ? [...c, o.value] : c.filter((v) => v !== o.value)))}
                />
                <Show when={o.emoji}>{(e) => <Emoji emoji={e()} />}</Show>
                {o.label}
                <Show when={o.description}>{(d) => <span class={styles.optionHint}>{d()}</span>}</Show>
              </label>
            )}
          </For>
          <button type="button" class="cp-button" disabled={chosen().length < s.minValues} onClick={() => props.onSend(chosen())}>
            Send
          </button>
        </fieldset>
      </Match>
    </Switch>
  );
}

function EntitySelect(props: { select: SelectMenu; message: ArchiveMessage; disabled: boolean; onSend: (values: string[]) => void }) {
  const s = props.select;
  const [chosen, setChosen] = createSignal<EntityChoice[]>([]);
  const guildId = (): string => channelById(props.message.channelId)?.guildId ?? '';
  return (
    <div class={styles.entitySelect}>
      <EntityPicker kind={s.kind as Exclude<SelectMenu['kind'], 'string'>} guildId={guildId()} channelTypes={s.channelTypes} max={s.maxValues} chosen={chosen()} onChange={setChosen} disabled={props.disabled} />
      <button type="button" class="cp-button" disabled={props.disabled || chosen().length < s.minValues} onClick={() => props.onSend(chosen().map((c) => c.id))}>
        Send
      </button>
    </div>
  );
}
