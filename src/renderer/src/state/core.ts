import { api } from '@/api';
import { createResource } from 'solid-js';
import { onAppEvent } from './events';

/** Storage health from the core process; refreshed whenever the archive changes (events are coalesced in core). */
export const [coreStatus, { refetch: refetchCoreStatus }] = createResource(() => api.core.status());

onAppEvent('archive-changed', () => void refetchCoreStatus());
