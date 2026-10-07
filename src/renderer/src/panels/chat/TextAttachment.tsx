// A stored text attachment shown as Discord does: the first 50 KB, 6 lines collapsed or 100 expanded, highlighted by its
// ending (or a picked language), and a window for the whole preview.
import { For, Show, createResource, createSignal } from 'solid-js';
import type { ArchiveAttachment } from '@shared/contract';
import { attachmentUrl } from '@shared/media';
import { TEXT_COLLAPSED_LINES, TEXT_EXPANDED_LINES, TEXT_PREVIEW_BYTES, textExtension } from '@shared/textFiles';
import { kilobytesText } from '@/ui/format';
import { ModalDialog } from '@/ui/ModalDialog';
import { Select } from '@/ui/Select';
import { LANGUAGES, highlightLines, languageFor, type CodeLine } from '@/ui/highlight';
import styles from './TextAttachment.module.css';

/** Decoding stops mid-character where the preview cuts a file; the replacement character it leaves is dropped. */
const CUT_CHARACTER = /�$/;

const LANGUAGE_OPTIONS = LANGUAGES.map((l) => ({ value: l.id, label: l.name }));
const CUT_NOTICE = 'This file is longer than the preview shows. Download it to read all of it.';

interface Preview {
  text: string;
  /** The file runs past the preview. */
  cut: boolean;
}

/** The file's first TEXT_PREVIEW_BYTES as UTF-8. Sliced here too, in case a server ignores the range. */
async function readPreview(url: string): Promise<Preview> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const total = Number(res.headers.get('content-range')?.split('/')[1]) || bytes.length;
  const cut = total > TEXT_PREVIEW_BYTES;
  const text = new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES));
  return { text: cut ? text.replace(CUT_CHARACTER, '') : text, cut };
}

function Code(props: { lines: CodeLine[] }) {
  return (
    <pre class={styles.code}>
      <code>
        <For each={props.lines}>
          {(line) => (
            <span class={styles.line}>
              <For each={line}>{(t) => <span style={t.color ? { color: t.color } : undefined}>{t.content}</span>}</For>
              {'\n'}
            </span>
          )}
        </For>
      </code>
    </pre>
  );
}

/** Selects the code alone, not the page, for Ctrl/Cmd+A inside the window. */
function selectCode(e: KeyboardEvent): void {
  if (e.key.toLowerCase() !== 'a' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const code = (e.currentTarget as HTMLElement).querySelector('code');
  if (!code) return;
  e.preventDefault();
  window.getSelection()?.selectAllChildren(code);
}

/** `onUnreadable`: the file can't be read or decoded, so the owner shows its chip instead. */
export function TextAttachment(props: { attachment: ArchiveAttachment; onUnreadable: () => void }) {
  const a = () => props.attachment;
  const [language, setLanguage] = createSignal(languageFor(textExtension(a().filename)));
  const [expanded, setExpanded] = createSignal(false);
  const [windowOpen, setWindowOpen] = createSignal(false);
  const [preview] = createResource(
    () => a().sha256 && attachmentUrl(a().sha256!, a().filename),
    async (url) => {
      try {
        return await readPreview(url);
      } catch (err) {
        props.onUnreadable();
        throw err;
      }
    },
  );
  const [lines] = createResource(
    () => preview() && ([preview()!.text, language()] as const),
    ([text, lang]) => highlightLines(text, lang),
  );
  const shown = () => lines()?.slice(0, expanded() ? TEXT_EXPANDED_LINES : TEXT_COLLAPSED_LINES) ?? [];
  const lineCount = () => lines()?.length ?? 0;
  return (
    <section class={styles.root} data-expanded={expanded()} aria-label={a().filename}>
      <header class={styles.header}>
        <span class={styles.name}>{a().filename}</span>
        <span class={styles.meta}>{kilobytesText(a().size)}</span>
        <Select class={styles.language} label="Language" value={language()} options={LANGUAGE_OPTIONS} onChange={setLanguage} />
      </header>
      <Show when={lines()} fallback={<div class={styles.loading} aria-busy="true" />}>
        <Code lines={shown()} />
      </Show>
      <footer class={styles.footer}>
        <Show when={lineCount() > TEXT_COLLAPSED_LINES}>
          <button type="button" class={styles.toggle} aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
            {expanded() ? 'Collapse' : `Expand (${Math.min(lineCount(), TEXT_EXPANDED_LINES)} of ${lineCount()} lines)`}
          </button>
        </Show>
        <Show when={lineCount() > TEXT_EXPANDED_LINES}>
          <button type="button" class={styles.viewAll} onClick={() => setWindowOpen(true)}>
            View whole file
          </button>
        </Show>
        <Show when={expanded() && preview()?.cut}>
          <span class={styles.notice}>{CUT_NOTICE}</span>
        </Show>
      </footer>
      {/* Mounted only while open: one dialog per shown file would sit in every log row. */}
      <Show when={windowOpen()}>
        <ModalDialog id={`text-attachment-${a().id}`} open title={a().filename} onClose={() => setWindowOpen(false)}>
          <div class={styles.window} onKeyDown={selectCode} tabIndex={-1}>
            <Code lines={lines() ?? []} />
            <Show when={preview()?.cut}>
              <span class={styles.notice}>{CUT_NOTICE}</span>
            </Show>
          </div>
        </ModalDialog>
      </Show>
    </section>
  );
}
