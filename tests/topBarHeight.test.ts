import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TOP_BAR_HEIGHT } from '../src/shared/windowControls';

// macOS places its traffic lights from TOP_BAR_HEIGHT; the bar is drawn at --cp-topbar-h.
it('the traffic lights centre on the top bar as the theme draws it', () => {
  const sizes = readFileSync(join(import.meta.dirname, '../src/renderer/src/theme/sizes.css'), 'utf8');
  expect(sizes.match(/--cp-topbar-h:\s*(\d+)px/)?.[1]).toBe(String(TOP_BAR_HEIGHT));
});
