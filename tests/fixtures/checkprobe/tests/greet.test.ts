import { expect, it, onTestFinished } from 'vitest';
import { testPlugin } from '@plugin-sdk/core/testing';
import { nextTs, tempDir } from '@chattypop/host-testing';
import { FIXTURE_PROVIDER_PLUGINS } from '@chattypop/host-testing/fixtureProviders';
import { textMessage } from '@core/queries/messageText';
import { bundledPlugin } from '@shared/bundledPlugins';
import probeCore from '../core';
import plugin from '../shared';

it('greets through the host, with the host test kit at hand', async () => {
  const t = testPlugin(probeCore);
  onTestFinished(() => t.dispose());
  await expect(t.client('renderer').greet('Ada')).resolves.toBe('Hello, Ada');
  expect(tempDir()).toBeTypeOf('string');
  expect(nextTs()).toBeTypeOf('number');
  // A listed helper by name, and host internals through the host's own aliases.
  expect(FIXTURE_PROVIDER_PLUGINS.length).toBeGreaterThan(0);
  expect(textMessage).toBeTypeOf('function');
  // The run's registry holds the folder under check, as one module: one copy of the plugin runs.
  expect(bundledPlugin(plugin.manifest.id)).toBe(plugin);
});
