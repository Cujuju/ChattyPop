/** Scheduling lane for committed archive reads. */
export type ReadPriority = 'interactive' | 'background';
/** Cancellation and scheduling for one served core call. */
export interface CallContext { readonly signal: AbortSignal; readonly priority: ReadPriority }
/** Serializable identity and scheduling; transports stamp the origin separately. */
export interface PluginCallRequest { readonly id: string; readonly priority: ReadPriority }

/** Validate before retaining caller-owned identities or choosing a lane. */
export function checkCallRequest(value: unknown): PluginCallRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !CALL_ID.test(value.id) ||
      !('priority' in value) || (value.priority !== 'interactive' && value.priority !== 'background')) throw new Error('Bad plugin call context');
  return { id: value.id, priority: value.priority };
}
/** UUIDs keep concurrent windows and HTTP requests independent without retaining a window identity. */
export const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
