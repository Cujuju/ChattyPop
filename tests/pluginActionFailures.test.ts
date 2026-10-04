// Plugin action failures: operational failures are run outcomes, late ones after unload are not plugin faults.
import { expect, it, vi } from 'vitest';
import { RuleKinds, type ActionRun } from '../src/core/rules/kinds';
import { pluginRules } from '../src/core/plugins/rules';
import { emptyRegistrations } from '../src/core/plugins/api';
import { probe as ruleProbe } from './pluginRuleDescriptor';
import { includeProbe } from './pluginRuleProbe';
import { PluginHost } from '../src/core/plugins/host';
import { defineCorePlugin } from '@plugin-sdk/core';
import { definePlugin } from '@plugin-sdk/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { getSetting } from '../src/core/db';
import { tempDb, tempDir } from './helpers';

// The rule probe's declarations stand in for any plugin's; its window action runs after messages, on a range.
includeProbe();
const ACTION = 'ruleprobe.window';

const run: ActionRun = {
  rule: { id: 1, name: 'Digest', managed: null, armedAt: 0, discordSend: false },
  actionId: 'summary', runId: 1, history: false,
  event: { kind: 'window', timing: 'daily', range: { sinceTs: 0, untilTs: 100, channelIds: null } },
};

it('records an operational failure as a failed run without a sticky plugin fault', async () => {
  const kinds = new RuleKinds();
  const faults: unknown[] = [];
  const rules = pluginRules(ruleProbe, kinds, emptyRegistrations(), {
    lastDone: () => null, attemptsSince: () => 0, update: () => undefined,
  }, (fn) => { try { fn(); } catch (error) { faults.push(error); } }, () => []);
  rules.action(ACTION, async () => ({ outcome: 'failed', detail: 'Provider quota exceeded' }));
  expect(await kinds.run(ACTION, null, run)).toEqual({ outcome: 'failed', detail: 'Provider quota exceeded' });
  expect(faults).toEqual([]);
});

it('does not report a rejection from an unloaded action as a plugin fault', async () => {
  const kinds = new RuleKinds();
  const reg = emptyRegistrations();
  const guard = vi.fn();
  const rules = pluginRules(ruleProbe, kinds, reg, {
    lastDone: () => null, attemptsSince: () => 0, update: () => undefined,
  }, guard, () => []);
  let reject!: (reason: Error) => void;
  rules.action(ACTION, () => new Promise((_, fail) => { reject = fail; }));
  const result = kinds.run(ACTION, null, run);
  reg.unloaded = true;
  reject(new Error('late failure'));
  await expect(result).resolves.toMatchObject({ outcome: 'failed' });
  expect(guard).not.toHaveBeenCalled();
});

it('gives a colliding folder its own inert settings identity without disabling the bundled owner', async () => {
  const db = tempDb();
  const dir = tempDir();
  const folder = join(dir, 'collision');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ id: 'probe', version: '1', apiVersion: PLUGIN_API_VERSION, main: 'index.js' }));
  const probe = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' } });
  // Disabled bundled entries do not require runtime services, but still reserve their id.
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('plugins.disabled', '["probe"]');
  const host = new PluginHost(dir, { db, emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null }, [defineCorePlugin(probe, () => undefined)]);
  await host.loadAll();
  const conflict = host.list().find((entry) => entry.conflict)!;
  expect(conflict.id).toBe('probe');
  expect(conflict.key).not.toBe('probe');
  await host.setEnabled(conflict.key!, true);
  expect(getSetting(db, 'plugins.disabled')).toEqual(['probe']);
  expect(host.list().find((entry) => entry.bundled)?.status).toBe('disabled');
});
