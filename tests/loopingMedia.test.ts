import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loopingMediaViolations } from '../scripts/pluginScan/rules';

// Looping media plays only while the owner can look at it (ui/looking.ts); plugin scanning applies the same rule.
const RENDERER_DIR = resolve(__dirname, '../src/renderer/src');

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsxFiles(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));

describe('looping media', () => {
  it('the renderer plays none on its own clock', () => {
    const files = tsxFiles(RENDERER_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => loopingMediaViolations({ rel: file, text: readFileSync(file, 'utf8') }))).toEqual([]);
  });

  it('names an autoplaying looped video and an emoji <img>, by line', () => {
    const text = [
      '<video src={a} autoplay loop muted />',
      '<video src={a} ref={loopWhileLooking} loop muted />',
      '<video src={a} controls />',
      '<img ref={(el) => use(el)} src={emojiUrl(e)} alt="" />',
      '<img src={avatarUrl(id, hash)} alt="" />',
    ].join('\n');
    expect(loopingMediaViolations({ rel: 'x.tsx', text })).toEqual([
      'x.tsx:1: a looping video plays while looked at: ref={loopWhileLooking}, not autoplay',
      'x.tsx:4: an emoji may be animated: <EmojiImage>, not <img>',
    ]);
  });
});