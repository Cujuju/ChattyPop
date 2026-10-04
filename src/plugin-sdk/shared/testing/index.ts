// Plugin SDK, shared testing (docs/plugin-architecture.md §15): the handles one process's test harness gives another's.
// Opaque: a test passes them along, and only the harnesses reach what they stand for.

/** A core test harness (@plugin-sdk/core/testing), as a main side's or a window's harness reaches it. */
export interface CoreLink {
  readonly coreLink: true;
}

/** A main test harness (@plugin-sdk/main/testing), as a window's harness reaches it. */
export interface MainLink {
  readonly mainLink: true;
}
