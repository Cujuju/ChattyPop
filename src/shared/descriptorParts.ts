// Plugin descriptor parts for AI providers and owner-set network addresses (docs/plugin-architecture.md §3, §4).

/** The key shape of a provider's API-key accounts. */
export interface ProviderApiKeyDecl {
  /** The key's shape, shown in the empty field (`sk-ant-…`). */
  placeholder: string;
}

/** The owner may add accounts of this provider in Settings → AI. */
export interface ProviderAccountsDecl {
  /** A CLI sign-in linked in ChattyPop, apart from this computer's own. */
  signIn?: boolean;
}

/** Registered AI providers are offered in Settings → AI, store ai.providers settings by id, and receive requests once the owner adds them. */
export interface ProviderDecl {
  /** Its plugin's id, or `<plugin id>.<name>`; stored choices name it, so it never changes. */
  id: string;
  /** Full name: its Settings → AI section and provider choices. */
  label: string;
  /** Short brand name (Plan usage); the owner may rename it. */
  displayName: string;
  /** @deprecated Ignored: a provider is off until the owner adds it. Only the upgrade of an older profile reads it. */
  enabledByDefault?: boolean;
  /** Runs on this PC: channels set to local AI only use it and no other. */
  local?: boolean;
  /** Reports plan limits, so Settings → AI offers to check them. */
  planUsage?: boolean;
  /** Its brand mark (Plan usage): one filled SVG path in a 24-unit box, drawn in the text colour. */
  logoPath?: string;
  /** Paid through the host's OpenRouter keys, which Settings → AI lists under it. */
  openRouterKeys?: boolean;
  accounts?: ProviderAccountsDecl;
  /** API-key accounts use this key shape. */
  apiKey?: ProviderApiKeyDecl;
  /** Some of its models read images sent with a prompt (CompletionRequest.images; ModelOption.images says which). */
  images?: boolean;
  /** Its own web page (an https URL): Settings → AI links it beside the section's title. */
  site?: string;
}

/** An address the owner sets: field `field` of the plugin's object preference `setting`, else `fallback`. */
export interface OwnerUrl {
  setting: string;
  field: string;
  fallback: string;
}
