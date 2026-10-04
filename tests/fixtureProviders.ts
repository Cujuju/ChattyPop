// Stand-ins for the AI provider plugins, declared as the plugins declare them, for plugin tests that ask providers
// (docs/plugin-architecture.md §16). In a test file:
//   vi.mock('virtual:bundled-plugins/shared', async (build) => (await import('@chattypop/host-testing/fixtureProviders')).withFixtureProviders(build));
import { definePlugin } from '@plugin-sdk/shared';
import type { PluginDescriptor } from '@shared/bundledTypes';

const manifest = (id: string, name: string) => ({ id, name, version: '1.0.0', description: `Fixture: the ${name} provider.` });

/** Two hosted plan providers, a local one and a hosted keyed one: the four the provider plugins declare. */
export const FIXTURE_PROVIDER_PLUGINS: readonly PluginDescriptor[] = [
  definePlugin({
    manifest: manifest('claude', 'Claude'),
    providers: [{ id: 'claude', label: 'Claude · Claude Code', displayName: 'Claude', enabledByDefault: true, planUsage: true }],
  }),
  definePlugin({
    manifest: manifest('codex', 'ChatGPT'),
    providers: [{ id: 'codex', label: 'ChatGPT · Codex', displayName: 'ChatGPT', enabledByDefault: true, planUsage: true }],
  }),
  definePlugin({
    manifest: manifest('ollama', 'Ollama'),
    providers: [{ id: 'ollama', label: 'Ollama · local', displayName: 'Ollama', enabledByDefault: false, local: true, images: true }],
  }),
  definePlugin({
    manifest: manifest('openrouter', 'OpenRouter'),
    providers: [{ id: 'openrouter', label: 'OpenRouter', displayName: 'OpenRouter', enabledByDefault: false, planUsage: true, openRouterKeys: true }],
  }),
];

/** The build's shared registry (the plugin under check) with the fixture providers after it. */
export async function withFixtureProviders<T extends { default: readonly PluginDescriptor[] }>(build: () => Promise<T>): Promise<T> {
  const original = await build();
  return { ...original, default: [...original.default, ...FIXTURE_PROVIDER_PLUGINS] };
}
