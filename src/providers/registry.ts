import type { GlobalConfig, ProviderType } from "../core/types.js";
import type { ICloudProvider } from "./cloudProviderTypes.js";

/**
 * v0.18 W2 — registry holds factory thunks; each `getFor(type)` invocation
 * creates a NEW provider instance (existing contract). We additionally
 * memoise per (type, factory) tuple so that hot paths (status bar refresh,
 * trigger manager) don't pay the construction cost on every call. The
 * cache is invalidated when `register()` is re-called for the same type
 * (sign-out reset path).
 */
export class ProviderRegistry {
  private readonly factories = new Map<ProviderType, () => ICloudProvider>();
  private readonly instances = new Map<ProviderType, ICloudProvider>();

  constructor(private readonly getConfig: () => Promise<GlobalConfig>) {}

  register(type: ProviderType, factory: () => ICloudProvider): void {
    this.factories.set(type, factory);
    // Drop any previously memoised instance — the factory may have changed.
    this.instances.delete(type);
  }

  async getActive(): Promise<ICloudProvider | null> {
    const cfg = await this.getConfig();
    const t = cfg.activeProvider;
    if (!t) {
      return null;
    }
    return this.getFor(t);
  }

  getFor(type: ProviderType): ICloudProvider | null {
    const cached = this.instances.get(type);
    if (cached) return cached;
    const factory = this.factories.get(type);
    if (!factory) return null;
    const fresh = factory();
    this.instances.set(type, fresh);
    return fresh;
  }

  async isAuthenticatedFor(type: ProviderType): Promise<boolean> {
    const p = this.getFor(type);
    if (!p) {
      return false;
    }
    try {
      return await p.isAuthenticated();
    } catch {
      return false;
    }
  }

  /** Drop the memoised instance for `type`. Used after sign-out so the
   *  next `getFor()` rebuilds with fresh token state. */
  resetInstance(type: ProviderType): void {
    this.instances.delete(type);
  }
}
