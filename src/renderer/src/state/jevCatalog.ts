// The Jev queries a window offers, and which one the Queries view shows (component-free, for tests).
import type { JevQueryDef } from '@shared/jevQueries';

/** Host queries, and a bundled plugin's only while `active(owner)`; reactive when `active` is. */
export const offeredQueries = (
  all: readonly JevQueryDef[],
  ownerOf: (id: string) => string | null,
  active: (pluginId: string) => boolean,
): JevQueryDef[] =>
  all.filter((d) => {
    const owner = ownerOf(d.id);
    return owner === null || active(owner);
  });

/** The picked query while it is offered, else the first offered one (its owner turned off). */
export const shownQuery = (offered: readonly JevQueryDef[], picked: string): JevQueryDef | undefined =>
  offered.find((d) => d.id === picked) ?? offered[0];
