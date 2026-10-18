// The query drawn over the search field: operators as Discord-style badges, the rest as plain text, scrolled with the field.
import { For } from "solid-js";
import { searchQuerySpans } from "@shared/searchQuery";
import styles from "./QueryBadges.module.css";

/**
 * Drawn glyph for glyph over the field's own (transparent) text; `class` gives it the field's box. Its text area clips
 * where the field's does, and its line shifts by the field's scroll (the field may scroll past its text, for the caret).
 * Takes no pointer or focus.
 */
export function QueryBadges(props: {
  class?: string;
  text: string;
  pluginKeys: readonly string[];
  scrollLeft: number;
}) {
  return (
    <div class={props.class} aria-hidden="true">
      <span class={styles.viewport}>
        <span
          class={styles.line}
          style={{ "--scroll-left": `${props.scrollLeft}px` }}
        >
          <For each={searchQuerySpans(props.text, props.pluginKeys)}>
            {(s) =>
              s.kind === "text" ? (
                s.text
              ) : (
                <span class={styles.term} data-state={s.state}>
                  <span class={styles.key}>{s.key}</span>
                  <span class={styles.value}>{s.value}</span>
                </span>
              )
            }
          </For>
        </span>
      </span>
    </div>
  );
}
