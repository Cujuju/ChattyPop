// Narrowing editors, display chips and removal of individual choices.
import { CONTENT_KINDS, CONTENT_KIND_INFO, type ContentKind } from '@shared/messageContent';
import { PLATFORMS, PLATFORM_INFO, type Platform } from '@shared/links';
import { AddPicker, AddTextChip } from '../pickers';
import type { FilterView } from './types';

/** Removes a selected chip, returning undefined when no narrowing remains. */
export interface RemovableFilter<C = unknown> extends FilterView<C> {
  remove(config: C, index: number): C | undefined;
}
const view = <C,>(v: RemovableFilter<C>): RemovableFilter => v as RemovableFilter;
const without = <C,>(c: C[], index: number): C[] | undefined => {
  const next = c.filter((_, i) => i !== index);
  return next.length ? next : undefined;
};

/** A typed site’s scheme and path, dropped so https://example.com/x becomes example.com. */
const URL_EXTRAS = /^[a-z]+:\/\/|\/.*$/g;
const acceptDomain = (raw: string): string | null => {
  const d = raw.trim().toLowerCase().replace(URL_EXTRAS, '');
  return d && !/\s/.test(d) ? d : null;
};
const contentChips = (c: ContentKind[]) => c.map((k) => CONTENT_KIND_INFO[k].label);
const platformChips = (c: Platform[]) => c.map((p) => `${PLATFORM_INFO[p].label} link`);
const domainChips = (c: string[]) => c.map((d) => `Link to ${d}`);
/** Editors, summaries and removable chips for each host narrowing kind. */
export const filterViews: Record<string, RemovableFilter> = {
  contains: view<ContentKind[]>({
    Editor: (p) => (
      <AddPicker
        label="Content"
        options={() =>
          CONTENT_KINDS.filter((k) => !p.config.includes(k)).map((k) => ({
            value: k,
            label: CONTENT_KIND_INFO[k].label,
            hint: CONTENT_KIND_INFO[k].hint,
          }))
        }
        onPick={(v) => p.onChange([...p.config, v as ContentKind])}
      />
    ),
    summary: (c) => contentChips(c).join(', '),
    chips: contentChips,
    remove: without,
  }),
  linkPlatforms: view<Platform[]>({
    Editor: (p) => (
      <AddPicker
        label="Link platform"
        options={() =>
          PLATFORMS.filter((k) => !p.config.includes(k)).map((k) => ({ value: k, label: PLATFORM_INFO[k].label }))
        }
        onPick={(v) => p.onChange([...p.config, v as Platform])}
      />
    ),
    summary: (c) => platformChips(c).join(', '),
    chips: platformChips,
    remove: without,
  }),
  linkDomains: view<string[]>({
    Editor: (p) => (
      <AddTextChip
        label="Link to a site"
        placeholder="example.com"
        accept={acceptDomain}
        refused="Write a site as a domain, e.g. example.com."
        onAdd={(v) => {
          if (!p.config.includes(v)) p.onChange([...p.config, v]);
        }}
      />
    ),
    summary: (c) => domainChips(c).join(', '),
    chips: domainChips,
    remove: without,
  }),

};
