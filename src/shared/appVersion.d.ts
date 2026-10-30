/** ChattyPop's version (`appVersion.ts`), injected at build time into main, core and renderer. */
declare const __APP_VERSION__: string;

/** Ed25519 public key (PEM) that update files must be signed with; empty when the build has none. */
declare const __UPDATE_PUBLIC_KEY__: string;