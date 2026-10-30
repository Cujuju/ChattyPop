// Where updates are published and how they are signed; shared by the app and scripts/release.ts.
import type { UpdateChannel } from '@cujuju/electron-updates';

export type { UpdateChannel };

/** The public repo whose releases are the updates. */
export const UPDATE_REPO = 'Cujuju/ChattyPop';

/** Binds signatures to ChattyPop, so a signature made for another app's files never verifies here. */
export const UPDATE_SIGNATURE_CONTEXT = 'chattypop-update-v1';

/** Settings → Desktop choices; the type is the updater's. */
export const UPDATE_CHANNELS = ['stable', 'nightly'] as const satisfies readonly UpdateChannel[];
