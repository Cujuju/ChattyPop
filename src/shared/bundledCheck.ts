// Pure descriptor checks validate ids, namespaces, duplicates and anchors identically across builds/catalogs and runtime installs.
import { checkArchiveRefs } from './archiveRefs';
import { HOST_SEARCH_KEYS } from './searchTokens';
import { HOST_JEV_FEATURES, PROVIDER_ID, isHostJevFeature } from './aiSettings';
import { HOST_NOTICE_KINDS } from './notices';
import { JEV_QUERY_GROUPS } from './jevQueries/groups';
import { HOST_JEV_QUERIES } from './jevQueries/host';
import { HOST_PANELS, HOST_SETTINGS_PAGES, HOST_SETTINGS_TABS, HOST_SHORTCUTS, checkAnchors, placementAnchor, type PlacementAnchor } from './anchors';
import { PLUGIN_ID_PATTERN } from './plugins';
import { isObj } from './normalize';
import { SECTION_AUDIENCES, type AnyChannels, type CallMember, type CompletionMember } from './pluginChannels';
import { HOST } from './ruleKinds/catalog';
import { HOST_SLOT_ITEMS, SLOT_KINDS, SLOT_LOCAL_ID, slotId, type SlotKind } from './slots';
import { TABLE_NAME, isDiscordHost, managedRuleKey, pluginTableName, stampedName, type PluginDescriptor } from './bundledTypes';

/** A managed rule's local key (before `<plugin id>.`): an identifier, so the namespaced key stays unambiguous. */
const MANAGED_RULE_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** A Jev switch key or notice kind before the host stamps `<plugin id>.`: an identifier, likewise. */
const LOCAL_NAME = MANAGED_RULE_KEY;

/** Adoption sources must be dotless pre-plugin names and cannot conflict with current host items of that kind. */
function checkAliasSource(id: string, what: string, old: string, name: RegExp, host: readonly string[]): void {
  if (!name.test(old) || host.includes(old)) throw new Error(`${id} adopts ${what} ${old}: a pre-plugin name, not a stamped or host one`);
}

/** A plugin shortcut's key: one lowercase letter. */
const SHORTCUT_KEY = /^[a-z]$/;
const HOST_KEYS: ReadonlySet<string> = new Set(Object.values(HOST_SHORTCUTS).flat());
/** A hostname as a descriptor lists it: lowercase labels, no scheme, port or path. */
const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A phone route's name: one lowercase path segment, served under the plugin's id. */
/** The highest TCP port number. */
const TCP_PORT_MAX = 65_535;

const PHONE_ROUTE_NAME = /^[a-z][a-z0-9-]*$/;
/** A plugin preference's name, and each dot-separated step of a field path into its value. */
const SETTING_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
/** A Jev query's id: `<area>.<name>`, identifiers; the owner's edits are stored under it. */
const JEV_QUERY_ID = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;

/** An empty catalog dictionary: no prototype, so any declared id (`__proto__` too) is an own entry. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Catalogs declared anchorable items, including omitted plugins, to distinguish missing owners from typos and preserve full-build placement. */
export interface AnchorCatalog {
  /** The plugins it describes: here, so an anchor on one of them that names nothing it declares is a typo. */
  plugins: string[];
  panels: Record<string, PlacementAnchor | null>;
  tabs: Record<string, string | null>;
  shortcuts: Record<string, string | null>;
  /** Each host slot's plugin items, by stamped id (`<plugin id>.<local id>`). */
  slots: Record<SlotKind, Record<string, PlacementAnchor | null>>;
  /** Plugins' notice kinds and Settings → Jev switches, by stamped name. */
  notices: Record<string, PlacementAnchor | null>;
  jevFeatures: Record<string, PlacementAnchor | null>;
  /** Plugins' Jev queries, by query id: each one's group, which its anchor must share. */
  jevQueries: Record<string, { group: string; anchor: PlacementAnchor | null }>;
}

/** Creates serializable anchor catalogs and rejects duplicate slot declarations before keyed storage can hide them. */
export function anchorCatalog(list: readonly PluginDescriptor[]): AnchorCatalog {
  const slots = Object.fromEntries(SLOT_KINDS.map((kind) => [kind, dict()])) as AnchorCatalog['slots'];
  const catalog: AnchorCatalog = { plugins: list.map((p) => p.manifest.id), panels: dict(), tabs: dict(), shortcuts: dict(), slots, notices: dict(), jevFeatures: dict(), jevQueries: dict() };
  for (const p of list) {
    for (const panel of p.panels ?? []) catalog.panels[panel.id] = panel.before !== undefined ? { before: panel.before } : (panel.after ?? null);
    for (const s of p.settings ?? []) if (s.tab) catalog.tabs[s.id] = s.tab.after;
    for (const s of p.shortcuts ?? []) catalog.shortcuts[s.key] = s.after;
    for (const kind of SLOT_KINDS) {
      for (const item of p.slots?.[kind] ?? []) {
        const id = slotId(p.manifest.id, item.id);
        if (Object.hasOwn(slots[kind], id)) throw new Error(`Two ${kind} items are ${id}`);
        slots[kind][id] = placementAnchor(item) ?? null;
      }
    }
    for (const n of p.notices ?? []) catalog.notices[stampedName(p.manifest.id, n.kind)] = placementAnchor(n) ?? null;
    for (const f of p.jev?.features ?? []) catalog.jevFeatures[stampedName(p.manifest.id, f.key)] = placementAnchor(f) ?? null;
    for (const q of p.jev?.queries ?? []) catalog.jevQueries[q.id] = { group: q.group, anchor: placementAnchor(q) ?? null };
  }
  return catalog;
}

/** Reads a slot item's anchor from `catalog` by stamped id; undefined for host items, unknown ids and items that append. */
export const catalogSlotAnchor = (catalog: AnchorCatalog) => (kind: SlotKind, id: string): PlacementAnchor | undefined =>
  (Object.hasOwn(catalog.slots[kind], id) ? catalog.slots[kind][id] : null) ?? undefined;

/** Reads a notice kind's anchor from `catalog` by stamped kind; undefined for host kinds, unknown kinds and kinds that append. */
export const catalogNoticeAnchor = (catalog: AnchorCatalog) => (kind: string): PlacementAnchor | undefined =>
  (Object.hasOwn(catalog.notices, kind) ? catalog.notices[kind] : null) ?? undefined;

/** Reads a Jev query's anchor from `catalog` by id; undefined for host queries, unknown ids and queries that append. */
export const catalogJevQueryAnchor = (catalog: AnchorCatalog) => (id: string): PlacementAnchor | undefined =>
  (Object.hasOwn(catalog.jevQueries, id) ? catalog.jevQueries[id]!.anchor : null) ?? undefined;

/** Old phone section ids the plugins in `list` adopted, each mapped to its plugin's stamped section: a plugin brings its own. */
export const adoptedPhoneSections = (list: readonly PluginDescriptor[]): ReadonlyMap<string, string> =>
  new Map(list.flatMap((p) => Object.entries(p.adopts?.phoneSections ?? {}).map(([old, local]) => [old, slotId(p.manifest.id, local)] as const)));

/** Throws on a slot item whose local id isn't an identifier or that names both directions, or a bad phone alias. */
function checkSlots(p: PluginDescriptor): void {
  const id = p.manifest.id;
  for (const kind of SLOT_KINDS) {
    for (const item of p.slots?.[kind] ?? []) {
      if (!SLOT_LOCAL_ID.test(item.id)) throw new Error(`${id} ${kind} item ${item.id}: its id must match ${SLOT_LOCAL_ID}`);
      // The type allows one direction; a descriptor built without it (a cast) is refused here.
      const both = item as { after?: string; before?: string };
      if (both.after !== undefined && both.before !== undefined) throw new Error(`${id} ${kind} item ${item.id}: choose before or after, not both`);
    }
  }
  for (const [old, local] of Object.entries(p.adopts?.phoneSections ?? {})) {
    checkAliasSource(id, 'phone section', old, SLOT_LOCAL_ID, HOST_SLOT_ITEMS.phoneSections);
    if (!p.slots?.phoneSections?.some((s) => s.id === local))
      throw new Error(`${id} adopts phone section ${old}: its destination must be a declared phone section`);
  }
}

/** Validates channel sections/audiences, core-only options, phone write flags/decoders and main-only core completion reports with positive integer capacity. */
function checkChannels(id: string, channels: AnyChannels | undefined): void {
  for (const [section, members] of Object.entries(channels?.audiences ?? {})) {
    if (!Object.hasOwn(SECTION_AUDIENCES, section)) throw new Error(`${id} channels: no section ${section} (core, main or events).`);
    const allowed: readonly string[] = SECTION_AUDIENCES[section as keyof typeof SECTION_AUDIENCES];
    for (const [name, member] of Object.entries(members)) {
      const completion = 'completion' in member ? (member as CompletionMember) : null;
      const call = !completion && !Array.isArray(member) ? (member as CallMember) : null;
      const options = completion ?? call;
      const audiences: unknown = options ? options.audiences : member;
      if (!Array.isArray(audiences) || !audiences.length) throw new Error(`${id} ${section} member ${name} needs at least one audience.`);
      const unknown = audiences.filter((a) => !allowed.includes(a));
      if (unknown.length) throw new Error(`${id} ${section} member ${name}: ${unknown.join(', ')} can't reach it (${allowed.join(', ')}).`);
      if (call && section !== 'core') throw new Error(`${id} ${section} member ${name}: only core members take options.`);
      if (call?.decode !== undefined && typeof call.decode !== 'function') throw new Error(`${id} core call ${name}: decode must be a function.`);
      if (section === 'core' && !completion && audiences.includes('phone')) {
        if (typeof call?.writes !== 'boolean') throw new Error(`${id} core call ${name}: the phone may make it, so it states writes (true or false).`);
        if (call.writes && !call.decode) throw new Error(`${id} core call ${name}: the phone may make it and it writes, so it needs a decoder.`);
      }
      if (!completion) continue;
      if (section !== 'core') throw new Error(`${id} ${section} member ${name}: only core members are completion reports.`);
      if (audiences.length !== 1 || audiences[0] !== 'main') throw new Error(`${id} completion report ${name} must be main-only.`);
      if (!Number.isInteger(completion.completion.max) || completion.completion.max < 1) throw new Error(`${id} completion report ${name}: max must be a positive integer.`);
    }
  }
}

/** Validates local/unique switch and notice ids, declared placement/query references and adoption targets. Rejects conflicting aliases and host-switch collisions. */
function checkVocabulary(p: PluginDescriptor, once: (what: string, id: string) => void): void {
  const id = p.manifest.id;
  const features = new Set<string>();
  for (const f of p.jev?.features ?? []) {
    if (!LOCAL_NAME.test(f.key) || isHostJevFeature(f.key)) throw new Error(`${id} Jev switch ${f.key}: a local identifier no host switch uses`);
    once('Jev switch', stampedName(id, f.key));
    features.add(f.key);
  }
  for (const f of p.jev?.features ?? []) {
    const { after, before } = f as { after?: string; before?: string }; // an untyped descriptor may give both
    if (after !== undefined && before !== undefined) throw new Error(`${id} Jev switch ${f.key}: one of after or before`);
    const anchor = placementAnchor(f);
    const target = typeof anchor === 'string' ? anchor : anchor?.before;
    const own = target?.startsWith(`${id}.`) && features.has(target.slice(id.length + 1));
    if (target !== undefined && !isHostJevFeature(target) && !own) throw new Error(`${id} Jev switch ${f.key}: placed by ${target}, not a host switch or its own`);
  }
  for (const q of p.jev?.queries ?? []) {
    if (!JEV_QUERY_ID.test(q.id)) throw new Error(`${id} Jev query ${q.id}: its id must match ${JEV_QUERY_ID}`);
    // Queries require groups to appear in settings and requests.
    if (!JEV_QUERY_GROUPS.includes(q.group)) throw new Error(`${id} Jev query ${q.id}: no group ${String(q.group)} (${JEV_QUERY_GROUPS.join(', ')})`);
    for (const f of q.features) if (!features.has(f) && !isHostJevFeature(f)) throw new Error(`${id} Jev query ${q.id}: no switch ${f}`);
    const { after, before } = q as { after?: string; before?: string }; // an untyped descriptor may give both
    if (after !== undefined && before !== undefined) throw new Error(`${id} Jev query ${q.id}: one of after or before`);
  }
  const kinds = new Set<string>();
  for (const n of p.notices ?? []) {
    if (!LOCAL_NAME.test(n.kind)) throw new Error(`${id} notice kind ${n.kind}: a local identifier`);
    const { after, before } = n as { after?: string; before?: string }; // an untyped descriptor may give both
    if (after !== undefined && before !== undefined) throw new Error(`${id} notice kind ${n.kind}: one of after or before`);
    once('notice kind', stampedName(id, n.kind));
    kinds.add(n.kind);
  }
  for (const [old, key] of Object.entries(p.adopts?.jevFeatures ?? {})) {
    checkAliasSource(id, 'Jev switch', old, LOCAL_NAME, HOST_JEV_FEATURES);
    if (!features.has(key)) throw new Error(`${id} adopts Jev switch ${old}: destination must be a declared switch`);
    once('adopted Jev switch', old);
  }
  for (const [old, kind] of Object.entries(p.adopts?.noticeKinds ?? {})) {
    checkAliasSource(id, 'notice kind', old, LOCAL_NAME, HOST_NOTICE_KINDS);
    if (!kinds.has(kind)) throw new Error(`${id} adopts notice kind ${old}: destination must be a declared kind`);
    once('adopted notice kind', old);
  }
}

/** Whether `p` declares preference `name`. */
const declares = (p: PluginDescriptor, name: string): boolean => !!p.preferences && Object.hasOwn(p.preferences, name);

/** Whether dot path `path` names a field of `value`, an object at every step. */
function resolves(value: unknown, path: string): boolean {
  let at = value;
  for (const step of path.split('.')) {
    if (!isObj(at) || !Object.hasOwn(at, step)) return false;
    at = at[step];
  }
  return true;
}

/** Whether `p` declares preference `name` and its default has field `field`, so an address or adopted field lands on a real one. */
const hasField = (p: PluginDescriptor, name: string, field: string): boolean =>
  declares(p, name) && SETTING_NAME.test(field) && resolves(p.preferences![name]!.default, field);

/** Throws on a preference with a bad name, no normalizer, or a phone view naming no field of its default. */
function checkPreferences(p: PluginDescriptor): void {
  for (const [name, pref] of Object.entries(p.preferences ?? {})) {
    if (!SETTING_NAME.test(name) || typeof pref.normalize !== 'function') throw new Error(`${p.manifest.id} preference ${name}: a name matching ${SETTING_NAME} and a normalizer`);
    const view = pref.phone;
    if (view === undefined || view === true) continue;
    if (!view.length || !view.every((path) => path.split('.').every((step) => SETTING_NAME.test(step)) && resolves(pref.default, path)))
      throw new Error(`${p.manifest.id} preference ${name}: its phone fields must be fields of its default`);
  }
}

/** The plugin a stamped name (`<id>.<item>`) belongs to; null for an unstamped one. */
const ownerOf = (name: string): string | null => {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : null;
};

/**
 * How checkBundled treats an unstamped anchor (panel, tab, shortcut) nothing seen declares: `typo` when it sees every
 * plugin that could (build, release), else `absent`. A stamped anchor's owner decides.
 */
export type UnknownAnchors = 'typo' | 'absent';

/** An item's anchor target, for loop and typo checks. */
const targets = (items: Record<string, PlacementAnchor | null>): Map<string, string | undefined> =>
  new Map(Object.entries(items).map(([id, a]) => [id, a === null ? undefined : typeof a === 'string' ? a : a.before]));
/** `items`' keys: the items the checked plugins declare. */
const keys = (items: object): ReadonlySet<string> => new Set(Object.keys(items));

/**
 * Throws on a bad registry (bad id, name, duplicate, anchor). Anchors resolve through `catalog`; one on another
 * plugin's item fails only if its plugin is here; `unknown` decides unstamped ones.
 */
export function checkBundled(list: readonly PluginDescriptor[], catalog: AnchorCatalog = anchorCatalog(list), unknown: UnknownAnchors = 'typo'): void {
  const seen = new Set<string>();
  const once = (what: string, id: string): void => {
    if (seen.has(`${what}:${id}`)) throw new Error(`Two bundled plugins provide ${what} ${id}`);
    seen.add(`${what}:${id}`);
  };
  for (const kinds of Object.values(HOST)) for (const kind of kinds) once('rule kind', kind.type);
  for (const q of HOST_JEV_QUERIES) once('Jev query', q.id);
  for (const p of list) {
    const id = p.manifest.id;
    checkArchiveRefs(p);
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`Bundled plugin id must match ${PLUGIN_ID_PATTERN}: ${id}`);
    once('plugin', id);
    if (p.coverage) once('coverage provider', 'coverage');
    if (p.aiRuns) once('AI run provider', 'aiRuns');
    for (const token of p.search?.tokens ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(token.key) || (HOST_SEARCH_KEYS as readonly string[]).includes(token.key))
        throw new Error(`Invalid plugin search token ${token.key}`);
      if (!token.description.trim() || !token.value.trim()) throw new Error(`Search token ${token.key} needs a description and a value placeholder.`);
      once('search token', token.key);
    }
    for (const provider of p.providers ?? []) {
      if (!PROVIDER_ID.test(provider.id) || (provider.id !== id && !provider.id.startsWith(`${id}.`)))
        throw new Error(`AI provider ${provider.id} must be ${id} or ${id}.<name>.`);
      once('AI provider', provider.id);
    }
    for (const q of p.jev?.queries ?? []) once('Jev query', q.id);
    checkVocabulary(p, once);
    for (const [section, kinds] of Object.entries(p.rules ?? {})) {
      for (const kind of kinds) {
        if (!kind.type.startsWith(`${id}.`) || !/^[^.]+\.[a-zA-Z][a-zA-Z0-9_]*$/.test(kind.type))
          throw new Error(`Rule kind ${kind.type} must be ${id}.<name>.`);
        once('rule kind', kind.type);
        if (kind.before !== undefined && kind.after !== undefined)
          throw new Error(`Rule kind ${kind.type}: choose before or after, not both.`);
        if (section === 'triggers' && 'event' in kind && kind.event !== 'message')
          throw new Error(`Plugin trigger ${kind.type} must use event: message.`);
      }
    }
    checkChannels(id, p.channels);
    checkSlots(p);
    for (const kind of SLOT_KINDS) for (const item of p.slots?.[kind] ?? []) once(`${kind} item`, slotId(id, item.id));
    for (const old of Object.keys(p.adopts?.phoneSections ?? {})) once('adopted phone section', old);
    for (const panel of p.panels ?? []) once('panel', panel.id);
    for (const s of p.settings ?? []) {
      once('settings page', s.id);
      if (!s.tab && !(HOST_SETTINGS_PAGES as readonly string[]).includes(s.page))
        throw new Error(`Settings section ${s.id}: no host page ${s.page}`);
    }
    for (const s of p.shortcuts ?? []) {
      if (!SHORTCUT_KEY.test(s.key) || HOST_KEYS.has(s.key))
        throw new Error(`${id} shortcut ${s.key}: must be a lowercase letter no host shortcut takes`);
      once('shortcut', s.key);
    }
    for (const host of p.network?.hosts ?? []) {
      if (!HOST_NAME.test(host)) throw new Error(`${id} network host ${host}: must be a lowercase hostname`);
      if (isDiscordHost(host))
        throw new Error(`${id} network host ${host}: Discord is reached only through the embedded session`);
    }
    checkPreferences(p);
    for (const u of p.network?.ownerUrls ?? []) {
      if (!hasField(p, u.setting, u.field) || !URL.canParse(u.fallback))
        throw new Error(`${id} owner URL ${u.setting}.${u.field}: needs a declared preference, a field of its default and a valid fallback URL`);
    }
    const tailnet = p.network?.tailnet;
    if (tailnet) {
      if (!p.network?.loopback) throw new Error(`${id} network.tailnet publishes a loopback server: declare network.loopback`);
      if (!Number.isInteger(tailnet.httpsPort) || tailnet.httpsPort < 1 || tailnet.httpsPort > TCP_PORT_MAX)
        throw new Error(`${id} network.tailnet.httpsPort ${tailnet.httpsPort}: must be a TCP port`);
      once('tailnet HTTPS port', String(tailnet.httpsPort));
    }
    if (p.phone?.transport) once('phone transport', 'phone');
    for (const route of p.phone?.routes ?? []) {
      if (!PHONE_ROUTE_NAME.test(route)) throw new Error(`${id} phone route ${route}: must match ${PHONE_ROUTE_NAME}`);
      once('phone route', `${id}/${route}`);
    }
    for (const [old, name] of Object.entries(p.adopts?.settings ?? {})) {
      if (!old || !declares(p, name)) throw new Error(`${id} adopts setting ${old}: destination must be a declared preference`);
    }
    for (const { key, field, name } of p.adopts?.settingFields ?? []) {
      if (!key || !hasField(p, name, field)) throw new Error(`${id} adopts field ${key}.${field}: destination must be a field of a declared preference`);
    }
    for (const [old, name] of Object.entries(p.adopts?.tables ?? {})) {
      if (!TABLE_NAME.test(old)) throw new Error(`${id} adopts table ${old}: names must match ${TABLE_NAME}`);
      pluginTableName(id, name);
    }
    for (const [old, type] of Object.entries(p.adopts?.actionKinds ?? {})) {
      if (!old || !p.rules?.actions?.some((action) => action.type === type))
        throw new Error(`${id} adopts action kind ${old}: destination must be a declared action`);
      once('adopted action kind', old);
    }
    for (const key of Object.keys(p.managedRules ?? {})) {
      if (!MANAGED_RULE_KEY.test(key)) throw new Error(`${id} validates managed rule ${key}: expected a local identifier`);
    }
    for (const [old, name] of Object.entries(p.adopts?.managedRules ?? {})) {
      if (!old || !MANAGED_RULE_KEY.test(name))
        throw new Error(`${id} adopts managed rule ${old}: expected a nonempty old key and a local identifier`);
      once('adopted managed rule', old);
      once('managed rule destination', managedRuleKey(id, name));
    }
  }
  // Only `list`'s items are checked; their chains run through the catalog and them.
  const own = anchorCatalog(list);
  const withOwn = <T>(section: (c: AnchorCatalog) => Record<string, T>): Record<string, T> => Object.assign(dict(), section(catalog), section(own));
  const unstampedAbsent = (): boolean => unknown === 'absent';
  checkAnchors(targets(withOwn((c) => c.panels)), new Set(HOST_PANELS), 'Panel', unstampedAbsent, keys(own.panels));
  checkAnchors(targets(withOwn((c) => c.tabs)), new Set(HOST_SETTINGS_TABS), 'Settings tab', unstampedAbsent, keys(own.tabs));
  checkAnchors(targets(withOwn((c) => c.shortcuts)), new Set(Object.keys(HOST_SHORTCUTS)), 'Shortcut', unstampedAbsent, keys(own.shortcuts));
  // Stamped names: plugins here (listed, or in the catalog) and the host's own namespaces can't be absent.
  const here = new Set([...own.plugins, ...catalog.plugins]);
  const stampedAbsent = (known: ReadonlySet<string>) => {
    const hostOwners = new Set([...known].map(ownerOf));
    return (anchor: string): boolean => {
      const owner = ownerOf(anchor);
      return owner !== null && !here.has(owner) && !hostOwners.has(owner);
    };
  };
  const check = (items: Record<string, PlacementAnchor | null>, known: ReadonlySet<string>, what: string, checked: ReadonlySet<string>): void =>
    checkAnchors(targets(items), known, what, stampedAbsent(known), checked);
  for (const kind of SLOT_KINDS) check(withOwn((c) => c.slots[kind]), new Set<string>(HOST_SLOT_ITEMS[kind]), `${kind} item`, keys(own.slots[kind]));
  check(withOwn((c) => c.notices), new Set<string>(HOST_NOTICE_KINDS), 'Notice kind', keys(own.notices));
  check(withOwn((c) => c.jevFeatures), new Set<string>(HOST_JEV_FEATURES), 'Jev switch', keys(own.jevFeatures));
  const hostQueryGroups = new Map(HOST_JEV_QUERIES.map((q) => [q.id, q.group as string]));
  const allQueries = withOwn((c) => c.jevQueries);
  const queries = Object.entries(own.jevQueries);
  check(Object.fromEntries(Object.entries(allQueries).map(([q, e]) => [q, e.anchor])), new Set(hostQueryGroups.keys()), 'Jev query', keys(own.jevQueries));
  // Settings lists queries by group, so an anchor in another group couldn't place its query.
  for (const [q, { group, anchor }] of queries) {
    const target = anchor === null ? undefined : typeof anchor === 'string' ? anchor : anchor.before;
    if (target === undefined) continue;
    // An anchor on a query whose plugin isn't here (checked above) has no group to compare.
    const targetGroup = hostQueryGroups.get(target) ?? (Object.hasOwn(allQueries, target) ? allQueries[target]!.group : group);
    if (targetGroup !== group) throw new Error(`Jev query ${q} (${group}) is placed by ${target}, in ${targetGroup}: anchor within its group`);
  }
}
