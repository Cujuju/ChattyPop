import { beforeEach, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

const env = vi.hoisted(() => ({
  phone: false,
  revealPanel: vi.fn(),
  onEvent: vi.fn((_listener: (event: AppEvent) => void) => () => undefined),
}));
vi.mock('@/state/ui', () => ({ get inCompanion() { return env.phone; } }));
vi.mock('@/state/layout', () => ({ revealPanel: env.revealPanel }));
vi.mock('@/api', () => ({ api: { onEvent: env.onEvent } }));

type OpenPanelEvent = Extract<AppEvent, { type: 'open-panel' }>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it.each([false, true])('opens a panel on the current surface (phone: %s)', async (phone) => {
  env.phone = phone;
  // Renderer imports stay dynamic so the Node typecheck does not follow browser-only modules.
  const panelPath = '../src/plugin-sdk/renderer/kit/openPanel';
  const eventsPath = '../src/plugin-sdk/renderer/appEvents';
  const { openPanel } = await import(panelPath) as { openPanel(id: string): void };
  const { onAppEvent } = await import(eventsPath) as {
    onAppEvent(type: 'open-panel', listener: (event: OpenPanelEvent) => void): () => void;
  };
  const heard = vi.fn();
  const off = onAppEvent('open-panel', heard);

  openPanel('probe.panel');
  expect(env.onEvent).toHaveBeenCalledTimes(1);
  if (phone) {
    expect(heard).toHaveBeenCalledExactlyOnceWith({ type: 'open-panel', panelId: 'probe.panel' });
    expect(env.revealPanel).not.toHaveBeenCalled();
  } else {
    expect(env.revealPanel).toHaveBeenCalledExactlyOnceWith('probe.panel');
    expect(heard).not.toHaveBeenCalled();
  }

  // Bridge events use the same listeners; removing one also stops local navigation delivery.
  heard.mockClear();
  const event: OpenPanelEvent = { type: 'open-panel', panelId: 'probe.notice' };
  env.onEvent.mock.calls[0]![0](event);
  expect(heard).toHaveBeenCalledExactlyOnceWith(event);
  off();
  heard.mockClear();
  openPanel('probe.panel');
  env.onEvent.mock.calls[0]![0](event);
  expect(heard).not.toHaveBeenCalled();
});
