import { expect, it } from 'vitest';
import { panelOwnerOff } from '../src/renderer/src/layout/visibility';
it('hides known inactive owners and retains removed plugin placeholders', () => {
  const owner = (id: string) => id === 'summary' ? 'summaries' : undefined;
  for (const status of ['disabled', 'error'] as const) {
    const hidden = (id: string) => panelOwnerOff(id, owner, () => false, [{ id: 'folder', status, bundled: false }]);
    expect(hidden('summary')).toBe(true);
    expect(hidden('plugin:folder:panel')).toBe(true);
    expect(hidden('plugin:removed:panel')).toBe(false);
    expect(hidden('chat')).toBe(false);
  }
});
