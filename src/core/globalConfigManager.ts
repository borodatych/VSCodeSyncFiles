import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { GlobalConfig, ProviderType, SecretStore } from "./types.js";

const CONFIG_FILE = "config.json";

function defaultConfig(): GlobalConfig {
  return {
    activeProvider: null,
    machineId: "",
    machineName: "",
    onboardingCompleted: false,
    syncPaused: false,
    providers: {},
  };
}

export class GlobalConfigManager {
  private cache: GlobalConfig | null = null;

  constructor(
    private readonly configDir: string,
    private readonly secrets: SecretStore | undefined,
  ) {}

  static resolveDefaultConfigDir(homedir: string = os.homedir()): string {
    return path.join(homedir, ".vscode", "vscodeSync");
  }

  getConfigPath(): string {
    return path.join(this.configDir, CONFIG_FILE);
  }

  /** Directory for `config.json`, locks, and auxiliary persisted JSON (e.g. schedule-deferred queue). */
  getStorageDir(): string {
    return this.configDir;
  }

  async load(): Promise<GlobalConfig> {
    if (this.cache) {
      return this.clone(this.cache);
    }
    const filePath = this.getConfigPath();
    let fromFile = false;
    let parsed = defaultConfig();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw) as Partial<GlobalConfig> & Record<string, unknown>;
      parsed = {
        ...defaultConfig(),
        ...data,
        providers: data.providers ?? {},
      };
      if ("onboardingCompleted" in data) {
        parsed.onboardingCompleted = Boolean(data.onboardingCompleted);
      } else {
        parsed.onboardingCompleted = true;
      }
      parsed.syncPaused = "syncPaused" in data ? Boolean(data.syncPaused) : false;
      fromFile = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
    let shouldPersist = !fromFile;
    if (!parsed.machineId) {
      parsed.machineId = randomUUID();
      shouldPersist = true;
    }
    if (!parsed.machineName) {
      parsed.machineName = os.hostname() || "default";
      shouldPersist = true;
    }
    this.cache = parsed;
    if (shouldPersist) {
      await this.save(parsed);
    }
    return this.clone(parsed);
  }

  async save(override?: GlobalConfig): Promise<void> {
    const toSave = override ?? this.cache ?? defaultConfig();
    const filePath = this.getConfigPath();
    const body = `${JSON.stringify(toSave, null, 2)}\n`;
    await writeTextFileAtomic(filePath, body);
    this.cache = this.clone(toSave);
  }

  async get<K extends keyof GlobalConfig>(key: K): Promise<GlobalConfig[K]> {
    const c = await this.load();
    return c[key];
  }

  /**
   * Update a field and persist to disk in one step. Default for callers that
   * don't need batched writes.
   *
   * For batched updates (multiple `set` calls in a row, single `save` at end),
   * use {@link setCached} explicitly.
   */
  async set<K extends keyof GlobalConfig>(key: K, value: GlobalConfig[K]): Promise<void> {
    await this.setCached(key, value);
    await this.save();
  }

  /**
   * Update a field in memory only; caller MUST invoke `save()` afterwards.
   * Use when you want to batch several updates into one disk write.
   */
  async setCached<K extends keyof GlobalConfig>(key: K, value: GlobalConfig[K]): Promise<void> {
    const c = await this.load();
    const next: GlobalConfig = { ...c, [key]: value };
    this.cache = next;
  }

  async getProviderSecret(type: ProviderType): Promise<string | undefined> {
    if (!this.secrets) {
      return undefined;
    }
    const key = `vscodesync.token.${type}`;
    return this.secrets.get(key);
  }

  async setProviderSecret(type: ProviderType, value: string): Promise<void> {
    if (!this.secrets) {
      return;
    }
    const key = `vscodesync.token.${type}`;
    await this.secrets.store(key, value);
  }

  async deleteProviderSecret(type: ProviderType): Promise<void> {
    if (!this.secrets) {
      return;
    }
    const key = `vscodesync.token.${type}`;
    await this.secrets.delete(key);
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private clone(c: GlobalConfig): GlobalConfig {
    return {
      ...c,
      providers: { ...c.providers },
    };
  }
}
