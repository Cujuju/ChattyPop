// An HTML export as the renderer hands it on: saved on the desktop, opened in a phone's browser (PhoneTransport.openPage).
export interface HtmlPage {
  /** A whole self-contained document. */
  html: string;
  /** The saved file's name, `.html` included. */
  fileName: string;
}

/** What the desktop draws as a one-page PDF (main/pdf.ts): the document and the width it lays out at. */
export interface PdfSource {
  html: string;
  /** CSS px; the page is as tall as its content at this width. */
  width: number;
}

/** A PDF export: its document, layout width and file name (`.pdf` included). */
export interface PdfPage extends PdfSource {
  fileName: string;
}

/** How a phone's browser opens an export: the document itself, or the desktop's PDF of it. */
export type ExportFormat = 'html' | 'pdf';

/** Narrowest and widest layout a PDF export may ask for, in CSS px: a phone screen up to a wide desktop. */
export const PDF_WIDTH_MIN = 320;
export const PDF_WIDTH_MAX = 4096;

/** A PDF export's source as sent over IPC or the phone, or it throws. */
export function decodePdfSource(v: unknown): PdfSource {
  const s = v as Partial<PdfSource> | null;
  if (typeof s?.html !== 'string' || typeof s.width !== 'number' || !Number.isFinite(s.width)) throw new Error('Not a PDF export.');
  return { html: s.html, width: Math.round(Math.min(PDF_WIDTH_MAX, Math.max(PDF_WIDTH_MIN, s.width))) };
}
