export type SyncAutoPauseReason = "metered" | "battery";

const listeners = new Set<() => void>();

function fire(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

let meteredPause = false;
let batteryPause = false;

function combined(): boolean {
  return meteredPause || batteryPause;
}

export const syncAutoPause = {
  /** Metered connection triggers pause (when detection succeeds). */
  isMeteredPaused(): boolean {
    return meteredPause;
  },

  isBatteryPaused(): boolean {
    return batteryPause;
  },

  isActive(): boolean {
    return combined();
  },

  getReason(): SyncAutoPauseReason | null {
    if (meteredPause) {
      return "metered";
    }
    if (batteryPause) {
      return "battery";
    }
    return null;
  },

  subscribe(listener: () => void): { dispose(): void } {
    listeners.add(listener);
    return {
      dispose(): void {
        listeners.delete(listener);
      },
    };
  },

  /**
   * Updates pause flags from polling. Returns whether combined active state changed.
   */
  commitPollingSnapshot(next: { metered: boolean; battery: boolean }): boolean {
    const prev = combined();
    meteredPause = next.metered;
    batteryPause = next.battery;
    const now = combined();
    if (prev !== now) {
      fire();
      return true;
    }
    return false;
  },
} as const;
