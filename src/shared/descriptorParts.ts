// Plugin descriptor parts for AI providers and owner-set network addresses (docs/plugin-architecture.md §3, §4).

/**
 * An AI provider a plugin registers (core ctx.ai.registerProvider). The host lists it in Settings → AI and provider
 * choices, keeps its settings under ai.providers by id, and routes requests to it while its plugin is on.
 */
export interface ProviderDecl {
  /** Its plugin's id, or `<plugin id>.<name>`; stored choices name it, so it never changes. */
  id: string;
  /** Full name: its Settings → AI section and provider choices. */
  label: string;
  /** Short brand name (Plan usage); the owner may rename it. */
  displayName: string;
  /** On in a profile that never turned it on or off. */
  enabledByDefault: boolean;
  /** Runs on this PC: channels set to local AI only use it and no other. */
  local?: boolean;
  /** Reports plan limits, so Settings → AI offers to check them. */
  planUsage?: boolean;
  /** Its brand mark (Plan usage): one filled SVG path in a 24-unit box, drawn in the text colour. */
  logoPath?: string;
  /** Paid through the host's OpenRouter keys, which Settings → AI lists under it. */
  openRouterKeys?: boolean;
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
