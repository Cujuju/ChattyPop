// Contract tests for notices.
import { describe, expect, it } from 'vitest';
import { noticesFor } from '@shared/notices';

describe('notices', () => {
  it('opens a plugin’s message only when it names one', () => {
    expect(noticesFor({ type: 'plugin-notify', pluginId: 'p', title: 'T', body: 'B' })[0]!.open).toBeNull();
    expect(noticesFor({ type: 'plugin-notify', pluginId: 'p', title: 'T', body: 'B', channelId: 'c', messageId: 'm' })[0]!.open).toEqual({ channelId: 'c', messageId: 'm' });
  });

  it('notices nothing else', () => {
    expect(noticesFor({ type: 'rules-changed' } as never)).toEqual([]);
  });
});
