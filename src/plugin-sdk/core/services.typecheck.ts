// Compile-time probe: the core SDK hands plugins its own interfaces, never a host service class (docs/plugin-architecture.md §4).
// @ts-expect-error The host's Jev judge is not an SDK export; plugins use ctx.jev.judgments and ctx.archive.replyTargets.
import { MessageJudge } from '@plugin-sdk/core';
// @ts-expect-error Nor is the importer as a slice of the host's Archive class; plugins get Importer.
import type { ArchiveImporter } from '@plugin-sdk/core';
import type { CoreContext, Importer, RangeJudgments } from '@plugin-sdk/core';
import type { MessageJudge as HostJudge } from '@core/jev/messageJudge';
import type { Archive } from '@core/archive';

/** True when `A` is assignable to `B`; a class with private members is assignable only from itself. */
type Assignable<A, B> = [A] extends [B] ? true : false;

// No context member is a host class.
export const judgmentsNotHost: Assignable<CoreContext['jev']['judgments'], HostJudge> = false;
export const importerNotHost: Assignable<ReturnType<CoreContext['archive']['store']>, Archive> = false;
// The SDK's names are the context's types.
export const judgmentsNamed: Assignable<CoreContext['jev']['judgments'], RangeJudgments> = true;
export const importerNamed: Assignable<ReturnType<CoreContext['archive']['store']>, Importer> = true;
