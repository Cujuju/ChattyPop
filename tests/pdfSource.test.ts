// Contract: a PDF export's source is checked and its layout width held to what a page may ask for.
import { describe, expect, it } from 'vitest';
import { PDF_WIDTH_MAX, PDF_WIDTH_MIN, decodePdfSource } from '@shared/htmlPage';

describe('PDF export source', () => {
  it('keeps the document and a width within bounds, and refuses anything else', () => {
    expect(decodePdfSource({ html: '<p>x</p>', width: 1200.4, fileName: 'x.pdf' })).toEqual({ html: '<p>x</p>', width: 1200 });
    expect(decodePdfSource({ html: '', width: 1 }).width).toBe(PDF_WIDTH_MIN);
    expect(decodePdfSource({ html: '', width: 1e9 }).width).toBe(PDF_WIDTH_MAX);
    for (const bad of [null, {}, { html: 1, width: 800 }, { html: '', width: Number.NaN }]) expect(() => decodePdfSource(bad)).toThrow(/Not a PDF/);
  });
});