import { describe, expect, it } from 'vitest';
import { applyBuiltinCommand, typedBuiltin } from '@shared/compose';
import { parseInline } from '../src/renderer/src/ui/mdParse';

/** The inline tree as plain text, with italics marked by * so a test can see them. */
const flat = (src: string): string =>
  parseInline(src)
    .map((n) => (n.k === 'text' ? n.text : n.k === 'em' ? `*${flat(n.children.map((c) => (c.k === 'text' ? c.text : '')).join(''))}*` : ''))
    .join('');

describe("Discord's built-in commands", () => {
  it('/shrug appends the shrug, with or without a message; the Archive shows it as typed', () => {
    expect(applyBuiltinCommand('/shrug')).toBe('¯\\\\_(ツ)\\_/¯');
    const sent = applyBuiltinCommand('/shrug  no idea ');
    expect(sent).toBe('no idea ¯\\\\_(ツ)\\_/¯');
    expect(flat(sent)).toBe('no idea ¯\\_(ツ)_/¯');
  });

  it('/tableflip and /unflip append their faces, which show as typed; /spoiler hides its message and needs one', () => {
    expect(applyBuiltinCommand('/tableflip')).toBe('(╯°□°)╯︵ ┻━┻');
    const unflip = applyBuiltinCommand('/unflip sorry');
    expect(unflip).toBe('sorry ┬─┬ノ( º _ ºノ)');
    expect(flat(unflip)).toBe(unflip);
    expect(applyBuiltinCommand('/spoiler he wins')).toBe('||he wins||');
    expect(() => applyBuiltinCommand('/spoiler')).toThrow('Type a message after /spoiler.');
  });

  it('/me sends its message in italics and needs one', () => {
    expect(applyBuiltinCommand('/me waves')).toBe('_waves_');
    expect(() => applyBuiltinCommand('/me')).toThrow('Type a message after /me.');
  });

  it('leaves other text alone, including unknown commands and names that only start like one', () => {
    expect(applyBuiltinCommand('hello /shrug')).toBe('hello /shrug');
    expect(applyBuiltinCommand('/meme time')).toBe('/meme time');
    expect(typedBuiltin('/SHRUG ok')?.command.name).toBe('shrug');
  });
});

describe('Archive markdown escapes', () => {
  it("doesn't close a styled run on an escaped delimiter, as Discord doesn't", () => {
    expect(flat('_a\\_b_')).toBe('*a_b*');
    expect(flat('\\_not italic_')).toBe('_not italic_');
  });
});

describe('Archive markdown timestamps', () => {
  it('shows a timestamp a Date can hold; one past its range stays text instead of breaking the row', () => {
    expect(parseInline('<t:1700000000:R>')).toEqual([{ k: 'time', unix: 1700000000, style: 'R' }]);
    expect(parseInline('<t:9999999999999>')).toEqual([{ k: 'text', text: '<t:9999999999999>' }]);
  });
});
