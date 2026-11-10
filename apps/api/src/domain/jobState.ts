/**
 * A SCHEDULED row must always own a live BullMQ job. These states mean the
 * job will never run again, so the reconciler must recreate it.
 */
export function jobStateNeedsRestoration(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'unknown';
}
