import { api } from '@/api';
import { createResource } from 'solid-js';
import { jevFeatureOn, type JevFeature } from '@shared/settings';
import { aiSettings, providerStatus, setJevFeature } from './preferences';

// Re-read whenever provider status refreshes (e.g. OpenRouter sign-in or sign-out).
const [statusResource, { refetch }] = createResource(providerStatus, () => api.core.jevStatus());

/** Jev's connection status; undefined while loading or failed (reading a failed resource throws). */
export const jevStatus = () => (statusResource.error ? undefined : statusResource());
export const refetchJevStatus = (): void => void refetch();

/** Switches a Jev feature, then re-reads Jev's status so Settings shows what the change did. */
export function toggleJevFeature(f: JevFeature, on: boolean): void {
  setJevFeature(f, on);
  refetchJevStatus();
}

/** A feature can't be turned on while Jev isn't set up; one that is on can always be turned off. */
export const jevFeatureLocked = (f: JevFeature): boolean => !jevStatus()?.available && !jevFeatureOn(aiSettings().jev, f);
