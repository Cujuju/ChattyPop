import { cutText } from '@shared/text';

/** Per-message cap so one wall of text can't crowd a prompt or a Jev state. */
export const MAX_MESSAGE_CHARS = 600;

/** One line of message text as AI sees it: whitespace flattened, long messages cut. */
export function clipMessage(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${cutText(flat, MAX_MESSAGE_CHARS)}…` : flat;
}
