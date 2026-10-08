// App-drawn confirmations and notices (ui/PromptDialog), in place of the browser's unthemed confirm() and alert().
import { createSignal } from 'solid-js';
import { errorText } from '@/ui/format';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** The button that goes ahead; the other cancels. */
  confirmLabel: string;
  /** It deletes or discards something: the go-ahead is drawn as danger and Cancel takes the focus. */
  danger?: boolean;
}

export interface TextOptions {
  title: string;
  /** The field's label. */
  message: string;
  confirmLabel: string;
  /** What the field starts with. */
  value?: string;
}

export interface NoticeOptions {
  title: string;
  message: string;
}

/** A prompt on screen or waiting its turn; `cancelLabel` null is a notice, with only its go-ahead. */
export interface Prompt {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string | null;
  danger: boolean;
  /** A text field's starting value; absent = no field. */
  input?: string;
  /** `text` is the field's value when it has one. */
  answer: (ok: boolean, text?: string) => void;
}

const NOTICE_LABEL = 'OK';
const CANCEL_LABEL = 'Cancel';

// One at a time: a prompt asked while another is open waits for it.
const [queue, setQueue] = createSignal<readonly Prompt[]>([]);

/** The prompt shown now, or null. */
export const shownPrompt = (): Prompt | null => queue()[0] ?? null;

function ask(p: Omit<Prompt, 'answer'>): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const prompt: Prompt = {
      ...p,
      answer: (ok, text = '') => {
        setQueue((q) => q.filter((x) => x !== prompt));
        resolve({ ok, text });
      },
    };
    setQueue((q) => [...q, prompt]);
  });
}

/** Asks the owner to go ahead; true when they do, false on Cancel, Esc or the close button. */
export const confirmDialog = (o: ConfirmOptions): Promise<boolean> =>
  ask({ title: o.title, message: o.message, confirmLabel: o.confirmLabel, cancelLabel: CANCEL_LABEL, danger: o.danger ?? false }).then((a) => a.ok);

/** Asks for a line of text; resolves with it trimmed, or null on Cancel, Esc, the close button or a blank entry. */
export const textDialog = (o: TextOptions): Promise<string | null> =>
  ask({ title: o.title, message: o.message, confirmLabel: o.confirmLabel, cancelLabel: CANCEL_LABEL, danger: false, input: o.value ?? '' })
    .then((a) => (a.ok ? a.text.trim() || null : null));

/** Tells the owner something; resolves once they dismiss it. */
export const noticeDialog = (o: NoticeOptions): Promise<void> =>
  ask({ title: o.title, message: o.message, confirmLabel: NOTICE_LABEL, cancelLabel: null, danger: false }).then(() => undefined);

/** A catch handler for a failed action: a notice titled `title` with the error's text; the chain doesn't wait for it. */
export const failureNotice =
  (title: string) =>
  (err: unknown): void =>
    void noticeDialog({ title, message: errorText(err) });
