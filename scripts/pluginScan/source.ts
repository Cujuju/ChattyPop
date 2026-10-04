// A plugin's source as plugin:check's scan reads it, and how a violation names its place.

/** One source file of a plugin folder. */
export interface SourceFile {
  /** Path relative to the plugin folder, with forward slashes. */
  rel: string;
  text: string;
}

/** The 1-based line of `index` in `text`. */
export const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** A violation as the scan reports it: `file:line: message`. */
export const violation = (rel: string, line: number, message: string): string => `${rel}:${line}: ${message}`;
