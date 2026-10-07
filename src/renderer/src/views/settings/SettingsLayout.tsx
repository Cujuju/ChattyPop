import { For, Show, createMemo, splitProps, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Select, type SelectOption } from '@/ui/Select';
import { setSettingsSections, settingsSections } from '@/state/ui';
import { look } from '@/theme/look';
import card from './SettingsCard.module.css';
import styles from './SettingsLayout.module.css';
import settings from './Settings.module.css';

/** One section of a Settings page: its rail entry and what opens beside it. */
export interface SettingsSectionDef {
  id: string;
  label: string;
  /** Rail group heading this entry sits under (entries of a group are adjacent). */
  group?: string;
  /** Starts a new block in the rail: a rule above this entry, without a heading. */
  divider?: true;
  /** One line under the label: the section's current state ("2.82 GB · no limit"). */
  meta?: () => string;
  /** Beside the entry in the rail, e.g. the feature's on/off switch. */
  aside?: () => JSX.Element;
  /** Dims the entry (a feature that's off). */
  muted?: () => boolean;
  /** Title of the open section; defaults to the label. */
  title?: string;
  /** An outside page linked beside the open section's title (a provider's site). */
  link?: { href: string; label: string };
  body: () => JSX.Element;
}


/** Opens a page's section from elsewhere (e.g. a link between Settings pages). */
export function openSettingsSection(page: string, section: string): void {
  void setSettingsSections({ ...settingsSections(), [page]: section });
}

/** A Settings page's head: title, controls on the right, then one line of purpose. */
export function PageHead(props: { id: string; title: string; lede?: JSX.Element; right?: JSX.Element }) {
  return (
    <header class={styles.head}>
      <h2 id={`${props.id}-heading`} class="cp-settings-title">
        {props.title}
      </h2>
      <Show when={props.right}>
        <div class={styles.headRight}>{props.right}</div>
      </Show>
      <Show when={props.lede}>
        <p class={styles.lede}>{props.lede}</p>
      </Show>
    </header>
  );
}

/** Extra rail entry classes beside the global cp-rail-* ones (e.g. an unread count's colour). */
export type RailClasses = Partial<Record<'railItem' | 'railButton' | 'railLabel' | 'railMeta' | 'railAside', string>>;

/** One rail entry: a button with its label and one-line meta, and an optional control beside it (a switch). */
export function RailItem(props: {
  label: JSX.Element;
  meta?: JSX.Element;
  /** Extra attributes on the meta line (e.g. data-unread, which its module colours). */
  metaAttrs?: Record<string, string | boolean | undefined>;
  /** Built once, when shown. */
  aside?: () => JSX.Element;
  current: boolean;
  muted?: boolean;
  title?: string;
  onClick: () => void;
  classes?: RailClasses;
}) {
  const cls = (): RailClasses => props.classes ?? {};
  return (
    <div class={`cp-rail-item ${cls().railItem ?? ''}`} data-muted={props.muted ? 'true' : undefined} data-current={props.current ? 'true' : undefined}>
      <button type="button" class={`cp-rail-button ${cls().railButton ?? ''}`} aria-current={props.current ? 'true' : undefined} title={props.title} onClick={() => props.onClick()}>
        <span class={`cp-rail-label ${cls().railLabel ?? ''}`}>{props.label}</span>
        <Show when={props.meta}>
          <span class={`cp-rail-meta ${cls().railMeta ?? ''}`} {...props.metaAttrs}>
            {props.meta}
          </span>
        </Show>
      </button>
      <Show when={props.aside}>{(a) => <span class={`cp-rail-aside ${cls().railAside ?? ''}`}>{a()()}</span>}</Show>
    </div>
  );
}

/** Settings sections show current summaries beside one editor; narrow windows use pickers. notice sits between page heading and sections. */
export function SectionsPage(props: { id: string; title: string; lede?: JSX.Element; right?: JSX.Element; notice?: JSX.Element; sections: SettingsSectionDef[] }) {
  /** The page's stored section while it still has it, else its first. */
  const openId = () => {
    const stored = settingsSections()[props.id];
    return props.sections.some((s) => s.id === stored) ? stored! : props.sections[0]!.id;
  };
  const open = createMemo(() => props.sections.find((s) => s.id === openId()) ?? props.sections[0]!);
  const groupStart = (i: number): string | undefined => {
    const g = props.sections[i]!.group;
    return g && g !== props.sections[i - 1]?.group ? g : undefined;
  };
  return (
    <section class="cp-settings-page" aria-labelledby={`${props.id}-heading`}>
      <PageHead id={props.id} title={props.title} lede={props.lede} right={props.right} />
      {props.notice}
      <div class="cp-settings-split">
        <nav class="cp-settings-rail" aria-label={`${props.title} sections`}>
          <For each={props.sections}>
            {(s, i) => (
              <>
                <Show when={s.divider && i() > 0}>
                  <hr class={styles.railDivider} />
                </Show>
                <Show when={groupStart(i())}>
                  {(g) => (
                    <h3 class={styles.railGroup} data-group={g()}>
                      <span class="cp-group-swatch" />
                      {g()}
                    </h3>
                  )}
                </Show>
                <RailItem
                  label={s.label}
                  meta={s.meta?.()}
                  aside={s.aside}
                  current={openId() === s.id}
                  muted={s.muted?.() ?? false}
                  onClick={() => openSettingsSection(props.id, s.id)}
                />
              </>
            )}
          </For>
        </nav>
        <div class={styles.picker}>
          <Select
            value={open().id}
            options={props.sections.map((s) => ({ value: s.id, label: s.group ? `${s.group} · ${s.label}` : s.label }))}
            label="Section"
            onChange={(v) => openSettingsSection(props.id, v)}
          />
        </div>
        <div class={styles.detail} data-group={open().group}>
          <div class={styles.detailHead}>
            <h3 class={styles.detailTitle}>{open().title ?? open().label}</h3>
            <Show when={open().link}>
              {(l) => (
                <a class={`${look.link} ${look.text}`} data-size="sm" data-weight="medium" href={l().href} target="_blank" rel="noreferrer" title={l().href}>
                  {l().label}
                </a>
              )}
            </Show>
          </div>
          {/* A component, not a call: a signal a body reads must not re-run the whole body and reset its state. */}
          <Dynamic component={open().body} />
        </div>
      </div>
    </section>
  );
}

/** A Settings page with one body (few settings): the same head, then cards. */
export function Page(props: { id: string; title: string; lede?: JSX.Element; right?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="cp-settings-page" aria-labelledby={`${props.id}-heading`}>
      <PageHead id={props.id} title={props.title} lede={props.lede} right={props.right} />
      <div class={styles.single}>{props.children}</div>
    </section>
  );
}

/** A titled group of rows. */
export function Card(props: { title?: string; meta?: JSX.Element; children: JSX.Element }) {
  return (
    <section class={card.card}>
      <Show when={props.title || props.meta}>
        <header class={card.cardHead}>
          <Show when={props.title}>
            <h4 class={card.cardTitle}>{props.title}</h4>
          </Show>
          <Show when={props.meta}>
            <span class={card.cardMeta}>{props.meta}</span>
          </Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

/** Settings rows place name/control above full-width explanation and children. for associates labels with controls. */
export function Row(props: { label: JSX.Element; for?: string; hint?: JSX.Element; control?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class={card.row}>
      <div class={card.rowMain}>
        <Show when={props.for} fallback={<span class={card.rowLabel}>{props.label}</span>}>
          <label class={card.rowLabel} for={props.for}>
            {props.label}
          </label>
        </Show>
        <Show when={props.control}>
          <div class={card.rowControl}>{props.control}</div>
        </Show>
      </div>
      <Show when={props.hint}>
        <span class={card.rowHint}>{props.hint}</span>
      </Show>
      <Show when={props.children}>
        <div class={card.rowBelow}>{props.children}</div>
      </Show>
    </div>
  );
}

/** A figure with its label: a value to read at a glance (sizes, costs, status). */
export function Stat(props: { label: string; value: JSX.Element; note?: JSX.Element }) {
  return (
    <div class={card.stat}>
      <span class="cp-stat-label">{props.label}</span>
      <span class={card.statValue}>{props.value}</span>
      <Show when={props.note}>
        <span class={card.statNote}>{props.note}</span>
      </Show>
    </div>
  );
}

/** Stats side by side. */
export const Stats = (props: { children: JSX.Element }) => <div class={card.stats}>{props.children}</div>;

/** A paragraph of explanation inside a section. */
export const Note = (props: { children: JSX.Element; kind?: 'error' | 'status' }) => (
  <p class="cp-note" data-kind={props.kind} role={props.kind === 'error' ? 'alert' : props.kind === 'status' ? 'status' : undefined}>
    {props.children}
  </p>
);

/** An enum choice's wording: in its select (`option`) and in a section's one-line state (`meta`). */
export interface ChoiceText {
  option: string;
  meta: string;
}

/** Select options from a choice table, in the table's order. */
export const choiceOptions = (table: Record<string, ChoiceText>): SelectOption[] => Object.entries(table).map(([value, t]) => ({ value, label: t.option }));

/** A number input and its unit ("30 days"). `label` names it when no row label is tied to `id`. */
export function NumberField(props: { id?: string; label?: string; min: number; max: number; step?: number; value: number; unit: string; onChange: (n: number) => void }) {
  return (
    <>
      <input
        id={props.id}
        type="number"
        aria-label={props.label}
        class={card.number}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.valueAsNumber)}
      />
      <span class={card.unit}>{props.unit}</span>
    </>
  );
}

/** An error note, shown only while there is an error. */
export const ErrorNote = (props: { error: string | null | undefined }) => <Show when={props.error}>{(e) => <Note kind="error">{e()}</Note>}</Show>;

/** A card's form: labelled fields (FormField) and its submit button on one line, then `children` (notes) under them. */
export function InlineForm(props: { onSubmit: () => void; fields: JSX.Element; button: JSX.Element; children?: JSX.Element }) {
  return (
    <form
      class={`${card.cardBody} ${card.inlineForm}`}
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div class={card.inlineFields}>
        {props.fields}
        {props.button}
      </div>
      {props.children}
    </form>
  );
}

/** One field of an InlineForm, its label over it; `id` ties them. */
export const FormField = (props: { id: string; label: string; children: JSX.Element }) => (
  <div class={card.field}>
    <label class={card.fieldLabel} for={props.id}>
      {props.label}
    </label>
    {props.children}
  </div>
);

/** Class names for controls placed in rows: a compact select or field, a narrow number, a button group; and a group of rows in a card. */
export const settingsControl = { select: card.select, number: card.number, wide: card.wide, buttons: card.buttons, unit: card.unit, cardBody: card.cardBody, group: card.group } as const;

/** A settings action button: the shared button, with room between an icon and its text; `tone="danger"` is the danger button. Other attributes pass through. */
export const SettingsButton = (props: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'type'> & { tone?: 'danger' }) => {
  const [local, rest] = splitProps(props, ['tone']);
  return <button type="button" {...rest} class={`${local.tone === 'danger' ? 'cp-danger' : 'cp-button'} ${settings.button}`} />;
};
