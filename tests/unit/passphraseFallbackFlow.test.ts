import { describe, expect, it } from "vitest";
import { planPassphraseFlow } from "../../src/core/passphraseFallbackFlow.js";

const NOW = 1_700_000_000_000;

describe("planPassphraseFlow — enroll", () => {
  it("returns the full enrollment step sequence on a strong passphrase", () => {
    const r = planPassphraseFlow({
      mode: "enroll",
      hasEnrolledPassphrase: false,
      strengthScore: 0.8,
      nowMs: NOW,
    });
    expect(r.steps).toEqual([
      "intro",
      "passphrase_strength_check",
      "confirm_passphrase",
      "derive_kek",
      "wrap_dek",
      "done",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("warns weak_passphrase_strength when score < 0.5", () => {
    const r = planPassphraseFlow({
      mode: "enroll",
      hasEnrolledPassphrase: false,
      strengthScore: 0.3,
      nowMs: NOW,
    });
    expect(r.warnings).toContain("weak_passphrase_strength");
  });

  it("does not warn when strengthScore is undefined (caller skipped check)", () => {
    const r = planPassphraseFlow({
      mode: "enroll",
      hasEnrolledPassphrase: false,
      nowMs: NOW,
    });
    expect(r.warnings).not.toContain("weak_passphrase_strength");
  });
});

describe("planPassphraseFlow — unlock", () => {
  it("returns the unlock step sequence with attemptsRemaining populated", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      recentFailedAttempts: 0,
      nowMs: NOW,
    });
    expect(r.steps).toEqual(["intro", "derive_kek", "unwrap_dek", "done"]);
    expect(r.attemptsRemaining).toBe(5);
  });

  it("warns no_passphrase_enrolled when there is nothing to unlock with", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: false,
      nowMs: NOW,
    });
    expect(r.warnings).toContain("no_passphrase_enrolled");
  });

  it("emits near_lockout when only one attempt remains before lockout", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      recentFailedAttempts: 4,
      nowMs: NOW,
    });
    expect(r.attemptsRemaining).toBe(1);
    expect(r.warnings).toContain("near_lockout");
  });

  it("does not emit near_lockout when 0 attempts remain (lockout itself takes over)", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      recentFailedAttempts: 5,
      nowMs: NOW,
    });
    expect(r.attemptsRemaining).toBe(0);
    expect(r.warnings).not.toContain("near_lockout");
  });
});

describe("planPassphraseFlow — lockout", () => {
  it("collapses to intro+done when lockout is active", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      lockoutStartedAtMs: NOW - 60_000,
      nowMs: NOW,
    });
    expect(r.steps).toEqual(["intro", "done"]);
    expect(r.warnings).toContain("lockout_active");
    expect(r.lockedUntilMs).toBe(NOW - 60_000 + 5 * 60_000);
  });

  it("treats expired lockout as not locked", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      lockoutStartedAtMs: NOW - 10 * 60_000,
      nowMs: NOW,
    });
    expect(r.lockedUntilMs).toBeNull();
    expect(r.warnings).not.toContain("lockout_active");
  });

  it("respects a caller-supplied lockoutDurationMs", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      lockoutStartedAtMs: NOW - 30_000,
      lockoutDurationMs: 60_000,
      nowMs: NOW,
    });
    expect(r.lockedUntilMs).toBe(NOW - 30_000 + 60_000);
  });
});

describe("planPassphraseFlow — recover", () => {
  it("inserts recovery_code_entry + rotate_after_recover", () => {
    const r = planPassphraseFlow({
      mode: "recover",
      hasEnrolledPassphrase: true,
      nowMs: NOW,
    });
    expect(r.steps).toEqual([
      "intro",
      "recovery_code_entry",
      "derive_kek",
      "unwrap_dek",
      "rotate_after_recover",
      "done",
    ]);
  });
});

describe("planPassphraseFlow — attemptsRemaining shape", () => {
  it("is null in non-unlock modes", () => {
    expect(
      planPassphraseFlow({
        mode: "enroll",
        hasEnrolledPassphrase: false,
        nowMs: NOW,
      }).attemptsRemaining,
    ).toBeNull();

    expect(
      planPassphraseFlow({
        mode: "recover",
        hasEnrolledPassphrase: true,
        nowMs: NOW,
      }).attemptsRemaining,
    ).toBeNull();
  });

  it("respects a caller-supplied maxAttempts override", () => {
    const r = planPassphraseFlow({
      mode: "unlock",
      hasEnrolledPassphrase: true,
      recentFailedAttempts: 1,
      maxAttempts: 3,
      nowMs: NOW,
    });
    expect(r.attemptsRemaining).toBe(2);
  });
});
