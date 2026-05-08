import { describe, expect, it } from "vitest";
import {
  isOnboardingAlreadyComplete,
  planOnboardingWizard,
} from "../../src/core/onboardingWizardSteps.js";

describe("planOnboardingWizard — fresh-install flow", () => {
  it("includes every step when nothing is configured", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: false,
      hasAuthenticatedTokens: false,
      hasMachineName: false,
      hasAttachedWorkspace: false,
    });
    expect(r.steps).toEqual([
      "intro",
      "pick_provider",
      "authenticate_provider",
      "name_machine",
      "pick_or_create_workspace",
      "configure_ignore_patterns",
      "first_sync",
      "done",
    ]);
  });

  it("logs an 'include' decision for each gated step", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: false,
      hasAuthenticatedTokens: false,
      hasMachineName: false,
      hasAttachedWorkspace: false,
    });
    expect(r.decisions.every((d) => d.reason === "include")).toBe(true);
  });
});

describe("planOnboardingWizard — partial state", () => {
  it("skips pick_provider when one is already active", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: true,
      hasAuthenticatedTokens: false,
      hasMachineName: false,
      hasAttachedWorkspace: false,
    });
    expect(r.steps).not.toContain("pick_provider");
    expect(
      r.decisions.find((d) => d.step === "pick_provider")?.reason,
    ).toBe("skip_already_configured");
  });

  it("skips authenticate_provider only when both provider AND tokens exist", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: true,
      hasAuthenticatedTokens: true,
      hasMachineName: false,
      hasAttachedWorkspace: false,
    });
    expect(r.steps).not.toContain("authenticate_provider");
    expect(
      r.decisions.find((d) => d.step === "authenticate_provider")?.reason,
    ).toBe("skip_already_authenticated");
  });

  it("retains authenticate_provider when provider exists but tokens missing", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: true,
      hasAuthenticatedTokens: false,
      hasMachineName: false,
      hasAttachedWorkspace: false,
    });
    expect(r.steps).toContain("authenticate_provider");
  });

  it("skips name_machine when already named", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: false,
      hasAuthenticatedTokens: false,
      hasMachineName: true,
      hasAttachedWorkspace: false,
    });
    expect(r.steps).not.toContain("name_machine");
  });

  it("skips pick_or_create_workspace when already attached", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: false,
      hasAuthenticatedTokens: false,
      hasMachineName: false,
      hasAttachedWorkspace: true,
    });
    expect(r.steps).not.toContain("pick_or_create_workspace");
    expect(
      r.decisions.find((d) => d.step === "pick_or_create_workspace")?.reason,
    ).toBe("skip_already_attached");
  });
});

describe("planOnboardingWizard — full-state collapse", () => {
  it("collapses to intro → ignore → first_sync → done when everything is configured", () => {
    const r = planOnboardingWizard({
      hasActiveProvider: true,
      hasAuthenticatedTokens: true,
      hasMachineName: true,
      hasAttachedWorkspace: true,
    });
    expect(r.steps).toEqual([
      "intro",
      "configure_ignore_patterns",
      "first_sync",
      "done",
    ]);
  });
});

describe("isOnboardingAlreadyComplete", () => {
  it("returns true only when all four prerequisites are satisfied", () => {
    expect(
      isOnboardingAlreadyComplete({
        hasActiveProvider: true,
        hasAuthenticatedTokens: true,
        hasMachineName: true,
        hasAttachedWorkspace: true,
      }),
    ).toBe(true);
  });

  it("returns false if any prerequisite is missing", () => {
    expect(
      isOnboardingAlreadyComplete({
        hasActiveProvider: true,
        hasAuthenticatedTokens: true,
        hasMachineName: true,
        hasAttachedWorkspace: false,
      }),
    ).toBe(false);
  });
});
