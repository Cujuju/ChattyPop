/** A thrown value's message: an Error's own, else the value as text. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
