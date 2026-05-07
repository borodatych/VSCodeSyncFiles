/**
 * UI / recovery hints when TCP or Graph transport fails (distinct from 429 / 401).
 */

let stickyTransportFailure = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    fn();
  }
}

export function noteCloudTransportFailure(): void {
  stickyTransportFailure = true;
  emit();
}

export function noteCloudTransportSuccess(): void {
  stickyTransportFailure = false;
  emit();
}

export function hasStickyUnreachableHint(): boolean {
  return stickyTransportFailure;
}

export function subscribeOfflineHints(listener: () => void): { dispose: () => void } {
  listeners.add(listener);
  return {
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

export function resetOfflineHintsForTests(): void {
  stickyTransportFailure = false;
  emit();
}
