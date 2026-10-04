// Host test kit helper files, imported as `@chattypop/host-testing/<file>` by plugin tests to mock a module before it
// loads (docs/plugin-architecture.md §16). The alias serves only these; tests/pluginCheck.test.ts checks them.
export const HOST_TESTING_FILES = ['archiveViewsFixture', 'fixtureProviders', 'perfArchiveFixture', 'pluginRuleProbe', 'providerHost', 'queryPlan', 'ruleFixtures'] as const;
