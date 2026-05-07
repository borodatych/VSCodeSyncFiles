import type { GlobalConfig, ProviderType } from "../core/types.js";
import type { ICloudProvider } from "./cloudProviderTypes.js";

export class ProviderRegistry {
  private readonly factories = new Map<ProviderType, () => ICloudProvider>();

  constructor(private readonly getConfig: () => Promise<GlobalConfig>) {}

  register(type: ProviderType, factory: () => ICloudProvider): void {
    this.factories.set(type, factory);
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
    const factory = this.factories.get(type);
    return factory ? factory() : null;
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
}
