export function jobStateNeedsRestoration(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'unknown';
}
