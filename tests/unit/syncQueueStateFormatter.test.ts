import { describe, expect, it } from "vitest";
import { formatQueueState } from "../../src/core/syncQueueStateFormatter.js";

const NOW = 1_700_000_000_000;

describe("formatQueueState — health classification", () => {
  it("returns 'idle' when activeCount and pendingCount are both 0", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 0, pendingCount: 0 }],
      { nowMs: NOW },
    );
    expect(rows[0].health).toBe("idle");
  });

  it("returns 'active' when there is in-flight work below the backed-up threshold", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 1, pendingCount: 2 }],
      { nowMs: NOW },
    );
    expect(rows[0].health).toBe("active");
  });

  it("returns 'backed_up' when pendingCount >= threshold (default 5)", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 1, pendingCount: 7 }],
      { nowMs: NOW },
    );
    expect(rows[0].health).toBe("backed_up");
  });

  it("respects a caller-supplied backedUpThreshold", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 0, pendingCount: 3 }],
      { nowMs: NOW, backedUpThreshold: 2 },
    );
    expect(rows[0].health).toBe("backed_up");
  });

  it("returns 'stalled' when oldestPendingAtMs is older than the stall threshold", () => {
    const rows = formatQueueState(
      [
        {
          provider: "gdrive",
          activeCount: 0,
          pendingCount: 1,
          oldestPendingAtMs: NOW - 90_000,
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].health).toBe("stalled");
  });

  it("respects a caller-supplied stalledOldestMs", () => {
    const rows = formatQueueState(
      [
        {
          provider: "gdrive",
          activeCount: 0,
          pendingCount: 1,
          oldestPendingAtMs: NOW - 10_000,
        },
      ],
      { nowMs: NOW, stalledOldestMs: 5_000 },
    );
    expect(rows[0].health).toBe("stalled");
  });

  it("does not flip to 'stalled' when oldestPendingAtMs is null/undefined even if pendingCount > 0", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 0, pendingCount: 1 }],
      { nowMs: NOW },
    );
    expect(rows[0].health).toBe("active");
  });
});

describe("formatQueueState — descriptions and details", () => {
  it("renders an 'active=N · pending=M' description", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 2, pendingCount: 3 }],
      { nowMs: NOW },
    );
    expect(rows[0].description).toBe("active=2 · pending=3");
  });

  it("renders 'Queue idle.' detail when nothing pending", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 0, pendingCount: 0 }],
      { nowMs: NOW },
    );
    expect(rows[0].detail).toBe("Queue idle.");
  });

  it("renders 'Oldest pending: Xs ago' for second-scale ages", () => {
    const rows = formatQueueState(
      [
        {
          provider: "gdrive",
          activeCount: 0,
          pendingCount: 1,
          oldestPendingAtMs: NOW - 12_000,
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].detail).toContain("12s ago");
  });

  it("renders minute + second scale", () => {
    const rows = formatQueueState(
      [
        {
          provider: "gdrive",
          activeCount: 0,
          pendingCount: 1,
          oldestPendingAtMs: NOW - 75_000,
        },
      ],
      { nowMs: NOW },
    );
    expect(rows[0].detail).toContain("1m 15s");
  });

  it("falls back to 'Oldest pending: unknown' when oldestPendingAtMs missing despite pendingCount", () => {
    const rows = formatQueueState(
      [{ provider: "gdrive", activeCount: 0, pendingCount: 1 }],
      { nowMs: NOW },
    );
    expect(rows[0].detail).toContain("unknown");
  });
});

describe("formatQueueState — multi-provider rendering", () => {
  it("returns one row per snapshot in input order", () => {
    const rows = formatQueueState(
      [
        { provider: "gdrive", activeCount: 0, pendingCount: 0 },
        { provider: "onedrive", activeCount: 1, pendingCount: 0 },
        { provider: "yandex", activeCount: 0, pendingCount: 8 },
      ],
      { nowMs: NOW },
    );
    expect(rows.map((r) => r.provider)).toEqual(["gdrive", "onedrive", "yandex"]);
    expect(rows.map((r) => r.health)).toEqual(["idle", "active", "backed_up"]);
  });
});
