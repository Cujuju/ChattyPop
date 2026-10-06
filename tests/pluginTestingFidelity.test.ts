// Plugin tests use installed rule kinds, copied cross-process events, core policy/session handlers, and main routing to windows and phones.
import { describe, expect, it, onTestFinished } from 'vitest';
import { AFTER_MESSAGE, defineChannels, definePlugin, defineRuleAction } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { defineMainPlugin, type MainContext } from '@plugin-sdk/main';
import { SETTINGS_KEYS } from '@shared/settings';
import { testPlugin } from '@plugin-sdk/core/testing';
import { testMainPlugin } from '@plugin-sdk/main/testing';
import type { AppEvent } from '@shared/contract';
import { corePort, mainPort } from '../src/plugin-sdk/shared/testing/ports';

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
/** A setting session times are read from, as core stores its heartbeat. */
const LAST_SEEN_KEY = 'session.lastSeenAt';

describe('the core harness', () => {
  it("registers and runs an action declared only by a plugin outside this build's registry", async () => {
    const probe = definePlugin({
      manifest: manifest('actionprobe'),
      rules: { actions: [defineRuleAction({ ...AFTER_MESSAGE, type: 'actionprobe.go', label: 'Go', hint: '', create: () => null, validate() {} })] },
    });
    const t = testPlugin(defineCorePlugin(probe, (ctx) => ctx.rules.action('actionprobe.go', () => ({ outcome: 'done', detail: 'went' }))));
    onTestFinished(() => t.dispose());
    expect(t.status()).toEqual({ status: 'active', error: null });
    expect(await t.rules.run('actionprobe.go', null, {} as never)).toEqual({ outcome: 'done', detail: 'went' });
  });

  it('hands each process its own copy of an event: a change after emitting reaches no one', async () => {
    const probe = definePlugin({
      manifest: manifest('copyprobe'),
      channels: defineChannels<{ core: { fire(): void }; events: { fired: { n: number } } }>()({ core: { fire: ['renderer'] }, events: { fired: ['renderer'] } }),
    });
    const t = testPlugin(
      defineCorePlugin(probe, (ctx) =>
        ctx.channels.serve({
          fire: () => {
            const payload = { n: 1 };
            ctx.channels.emit('fired', payload);
            payload.n = 2;
          },
        }),
      ),
    );
    onTestFinished(() => t.dispose());
    const heard: AppEvent[] = [];
    corePort(t.link).on((e) => void heard.push(e));
    await t.client('renderer').fire();
    expect(t.events('fired')).toEqual([{ n: 1 }]);
    expect(heard.flatMap((e) => (e.type === 'plugin-event' ? [e.payload] : []))).toEqual([{ n: 1 }]);
  });

  it("changes a channel's marks through core's handler, with the events windows and main act on", () => {
    const t = testPlugin(definePlugin({ manifest: manifest('policyprobe') }), { archive: { channels: [{ id: 'c1' }] } });
    onTestFinished(() => t.dispose());
    const heard: string[] = [];
    corePort(t.link).on((e) => void heard.push(e.type));
    t.archive.setChannel('c1', { hidden: true });
    expect(heard).toEqual(['opt-in-changed', 'privacy-changed']);
  });

  it("reads the previous session's time from the profile, as core does at start, and records this one", () => {
    const seen: number[] = [];
    const probe = definePlugin({ manifest: manifest('sessionprobe') });
    const t = testPlugin(defineCorePlugin(probe, (ctx) => void seen.push(ctx.session.lastSeenAt())), { profile: { settings: { [LAST_SEEN_KEY]: 1_000 } }, clock: () => 5_000 });
    const again = t.restart();
    onTestFinished(() => again.dispose());
    expect(seen).toEqual([1_000, 5_000]);
  });
});

describe('the main harness', () => {
  it("routes core's events to windows and to the phone as main's router does, plugin events by their audiences", async () => {
    const probe = definePlugin({
      manifest: manifest('routeprobe'),
      channels: defineChannels<{ core: { fire(): void }; events: { desk: number; phone: number } }>()({
        core: { fire: ['renderer'] },
        events: { desk: ['renderer'], phone: ['phone'] },
      }),
    });
    const core = testPlugin(
      defineCorePlugin(probe, (ctx) =>
        ctx.channels.serve({
          fire: () => {
            ctx.channels.emit('desk', 1);
            ctx.channels.emit('phone', 2);
          },
        }),
      ),
      { archive: { channels: [{ id: 'c1' }] } },
    );
    onTestFinished(() => core.dispose());
    const main = await testMainPlugin(defineMainPlugin(probe, () => undefined), core);
    onTestFinished(() => main.stop());
    const windows: AppEvent[] = [];
    const phone: AppEvent[] = [];
    mainPort(main.link).on((e) => void windows.push(e));
    mainPort(main.link).onPhone((e) => void phone.push(e));
    core.archive.arrive([{ channelId: 'c1', content: 'hi' }]);
    await core.client('renderer').fire();
    const named = (es: AppEvent[]) => es.map((e) => (e.type === 'plugin-event' ? e.name : e.type));
    expect(named(windows)).toEqual(['archive-changed', 'desk']);
    expect(named(phone)).toEqual(['archive-changed', 'phone']);
  });

  it("applies core's muted places to a plugin's notices", async () => {
    const probe = definePlugin({ manifest: manifest('muteprobe') });
    const core = testPlugin(defineCorePlugin(probe, () => undefined), { archive: { channels: [{ id: 'c1' }, { id: 'c2' }] } });
    onTestFinished(() => core.dispose());
    let ctx!: MainContext<typeof probe>;
    const main = await testMainPlugin(defineMainPlugin(probe, (c) => void (ctx = c)), core);
    onTestFinished(() => main.stop());
    await corePort(core.link).call('setSetting', SETTINGS_KEYS.notifications, { desktop: true, muted: { guildIds: [], channelIds: ['c1'] } });
    for (const channelId of ['c1', 'c2']) await ctx.notifications.show({ title: channelId, body: '', target: { kind: 'message', channelId, messageId: 'm' } });
    expect(main.notifications().desktop.map((n) => n.title)).toEqual(['c2']);
  });
});
