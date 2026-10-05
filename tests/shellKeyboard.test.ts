// Contract: the iPhone shell sets the keyboard's custom properties under the names the theme reads, and the theme eases
// the inset (a registered length) over the duration the shell sets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL_KEYBOARD_PROPERTIES } from '../src/shared/shell';

const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', ...parts), 'utf8');
const swift = read('ios', 'App', 'App', 'ShellViewController.swift');
const sizes = read('src', 'renderer', 'src', 'theme', 'sizes.css');
const easing = `transition: ${SHELL_KEYBOARD_PROPERTIES.inset} var(${SHELL_KEYBOARD_PROPERTIES.duration}) var(--cp-ease-keyboard)`;

describe('shell keyboard inset', () => {
  it('the shell sets the properties the theme reads', () => {
    for (const name of Object.values(SHELL_KEYBOARD_PROPERTIES)) expect(swift).toContain(`"${name}"`);
  });

  it('the theme registers the inset as a length and defaults the duration', () => {
    expect(sizes).toMatch(new RegExp(`@property ${SHELL_KEYBOARD_PROPERTIES.inset} \\{[^}]*syntax: '<length>'`));
    expect(sizes).toContain(`${SHELL_KEYBOARD_PROPERTIES.duration}: 0ms`);
  });

  it('every page the shell shows eases it', () => {
    expect(read('src', 'renderer', 'src', 'theme', 'base.css')).toContain(easing);
    expect(read('src', 'renderer', 'src', 'theme', 'pair.css')).toContain(easing);
  });
});
