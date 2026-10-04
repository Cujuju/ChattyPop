// Plugin preferences (docs/plugin-architecture.md §4, §7): a plugin's stored values, each declared once in its descriptor
// with its default and normalizer, so core, main and every window read and write it typed. Stored as plugin.<id>.<name>.

/** Field steps a phone projection or owner address may take: ask's `<kind>.enabled` needs two; one more keeps headroom. */
type PathDepth = [unknown, unknown, unknown];
type FieldKeys<T> = T extends readonly unknown[] ? never : T extends object ? Extract<keyof T, string> : never;

/** Dot paths into T's nested object fields (not into arrays), at most PathDepth steps. */
export type FieldPath<T, Steps extends unknown[] = []> = Steps['length'] extends PathDepth['length']
  ? never
  : { [K in FieldKeys<T>]: K | `${K}.${FieldPath<NonNullable<T[K]>, [...Steps, unknown]>}` }[FieldKeys<T>];

/** How much of a preference the paired phone reads: all of it, or these fields; the rest reads as unset there. */
export type PhoneView<T = unknown> = true | readonly FieldPath<T>[];

/** One preference: its value while nothing valid is stored, how any stored value becomes a valid one, and the phone's view. */
export interface Preference<T> {
  default: T;
  /** Any stored value (an older shape, another window's write) as a valid T. */
  normalize(v: unknown): T;
  /** Omitted: the phone reads it as unset, so desktop-only parts (prompts, models) stay on the PC. */
  phone?: PhoneView<T>;
}

/** A preference as the descriptor holds it, whatever its value type. */
export interface AnyPreference {
  default: unknown;
  normalize(v: unknown): unknown;
  phone?: true | readonly string[];
}

/** Declares a preference; its type is what `normalize` returns. */
export const definePreference = <T>(p: { default: NoInfer<T>; normalize(v: unknown): T; phone?: PhoneView<NoInfer<T>> }): Preference<T> => p;

/** Preference names a descriptor declares. */
export type PreferenceNames<D> = D extends { preferences: infer P } ? Extract<keyof P, string> : never;
/** The value type of a declared preference. */
export type PreferenceValue<D, N extends string> = D extends { preferences: { [K in N]: { normalize(v: unknown): infer T } } } ? T : never;
/** A field of a declared object preference's value. */
export type PreferenceField<D, N extends string> = FieldKeys<PreferenceValue<D, N>>;

/** A plugin's preferences in core: read and written at once. */
export interface CorePreferences<D> {
  /** The stored value, normalized; the default while nothing is stored. */
  get<N extends PreferenceNames<D>>(name: N): PreferenceValue<D, N>;
  /** The raw stored value (undefined when never saved), for reading an older shape once. */
  stored(name: PreferenceNames<D>): unknown;
  /** Normalizes, saves and tells every window and main (and onChange). */
  set<N extends PreferenceNames<D>>(name: N, value: PreferenceValue<D, N>): void;
  /** Its preference `name` was saved, by any window, main or set; `fn` gets the normalized value. */
  onChange<N extends PreferenceNames<D>>(name: N, fn: (value: PreferenceValue<D, N>) => void): void;
}

/** A plugin's preferences in main: through core, so reads and writes are asynchronous. */
export interface MainPreferences<D> {
  get<N extends PreferenceNames<D>>(name: N): Promise<PreferenceValue<D, N>>;
  set<N extends PreferenceNames<D>>(name: N, value: PreferenceValue<D, N>): Promise<void>;
  onChange<N extends PreferenceNames<D>>(name: N, fn: (value: PreferenceValue<D, N>) => void): void;
}

/** The declaration of `plugin`'s preference `name`; throws when it declares none, so an undeclared name never reaches storage. */
export function preferenceOf(plugin: { manifest: { id: string }; preferences?: Readonly<Record<string, AnyPreference>> }, name: string): AnyPreference {
  const p = plugin.preferences && Object.hasOwn(plugin.preferences, name) ? plugin.preferences[name] : undefined;
  if (!p) throw new Error(`${plugin.manifest.id} declares no preference ${name}`);
  return p;
}

/** A stored value as its preference reads it: the default when nothing is stored, else normalized. */
export const readPreference = (p: AnyPreference, stored: unknown): unknown => (stored === undefined ? p.default : p.normalize(stored));
