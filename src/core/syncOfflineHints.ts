/**
 * UI / recovery hints when TCP or Graph transport fails (distinct from 429 / 401).
 */

let stickyTransportFailure = false;
const listeners = new Set<() => void>();
/** Notified when a cloud request gets through. Policy modules subscribe here. */
const successListeners = new Set<() => void>();

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
  for (const fn of successListeners) {
    fn();
  }
}

/**
 * Subscribe to "a cloud request succeeded".
 *
 * Exists so the transport layer can report a *fact* without knowing what any
 * policy does with it (F6): the offline-flush backoff resets on this signal,
 * but the provider that emitted it has no idea such a policy exists.
 */
export function onCloudTransportSuccess(listener: () => void): { dispose: () => void } {
  successListeners.add(listener);
  return {
    dispose: () => {
      successListeners.delete(listener);
    },
  };
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
