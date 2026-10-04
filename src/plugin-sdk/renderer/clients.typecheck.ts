// Compile-time probe: each window's client types exactly the core calls its audience serves (docs/plugin-architecture.md §5).
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { coreClient, desktopCoreClient, phoneCoreClient, pluginResource } from '@plugin-sdk/renderer';

interface ProbeCalls {
  both(n: number): string;
  desktopOnly(): number;
  phoneOnly(): boolean;
}
const probe = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  channels: defineChannels<{ core: ProbeCalls }>()({ core: { both: { audiences: ['renderer', 'phone'], writes: false }, desktopOnly: ['renderer'], phoneOnly: { audiences: ['phone'], writes: false } } }),
});

export async function probeClients(): Promise<void> {
  const desktop = desktopCoreClient(probe);
  const counted: number = await desktop.desktopOnly();
  // @ts-expect-error A phone-only member is not on a desktop window's client.
  void desktop.phoneOnly;
  // @ts-expect-error Arguments are the member's.
  void desktop.both('one');

  const phone = phoneCoreClient(probe);
  const shown: boolean = await phone.phoneOnly();
  // @ts-expect-error A desktop-only member is not on the phone's client.
  void phone.desktopOnly;

  // Code either window runs: common members are there; one window's alone may be absent.
  const either = coreClient(probe);
  const text: string = await either.both(counted);
  // @ts-expect-error A single-audience member may be undefined in this window.
  void either.phoneOnly();
  const maybe: boolean | undefined = await either.phoneOnly?.();
  void [shown, text, maybe];
}

export function probeResource(): void {
  const r = pluginResource(probe, 'both', () => [1], null);
  const value: string | null = r();
  // @ts-expect-error Arguments are the member's.
  pluginResource(probe, 'both', () => ['one'], null);
  // @ts-expect-error Only members a window may call.
  pluginResource(probe, 'missing', () => [], null);
  void value;
}
