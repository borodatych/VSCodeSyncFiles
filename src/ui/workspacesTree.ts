import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import {
  workspaceHealthEmoji,
  workspaceHealthFromLocalCfg,
  type WorkspaceHealthLevel,
} from "./workspaceHealthLocal.js";
import { workspaceHealthThemeColor } from "./workspaceHealthThemeColor.js";
import { workspaceTreeContextValue } from "./workspaceTreeContext.js";
import { planFileTreeChildren } from "../core/plan/planFileTree.js";
import type { ManifestMachineCacheEntry, ProviderType, WorkspaceSyncState } from "../core/types.js";
import { formatMachinePresenceLines } from "./workspaceMachinePresence.js";

/** Элемент дерева для `TreeDataProvider<SyncTreeElement>` — в контекстное меню VS Code передаётся именно он. */
export type SyncTreeElement =
  | { kind: "rootFolder"; folder: vscode.WorkspaceFolder }
  | {
      kind: "workspace";
      folderRoot: vscode.Uri;
      workspaceId: string;
      note: string;
      tags: string[];
      manifestMachines: ManifestMachineCacheEntry[];
      health: { level: WorkspaceHealthLevel; summaryLines: string[] };
      syncState?: WorkspaceSyncState;
    }
  | {
      kind: "cloudSection";
      anchorFolder: vscode.Uri;
      offers: { workspaceId: string; workspaceNote: string }[];
    }
  | {
      kind: "remoteOffer";
      anchorFolder: vscode.Uri;
      workspaceId: string;
      workspaceNote: string;
    }
  | {
      /**
       * Folder node of the tracked-file tree (docs/v2/linkBindings.md). Exists
       * so folder-level actions — bind, pull, exclude — have something to hang
       * on, and so a 60-file workspace reads as the structure the user knows.
       */
      kind: "fileFolder";
      folderRoot: vscode.Uri;
      workspaceId: string;
      workspaceNote: string;
      /** Grouping posix prefix, no trailing slash (see `space`). */
      localPrefix: string;
      name: string;
      fileCount: number;
      missingCount: number;
      canonicalPrefix?: string;
      /**
       * Which path space the tree groups by. In canonical mode `localPrefix`
       * holds the CLOUD prefix and `canonicalPrefix` the local placement —
       * commands that touch the disk must check this instead of assuming.
       */
      space?: "local" | "canonical";
    }
  | {
      kind: "file";
      folderRoot: vscode.Uri;
      workspaceId: string;
      workspaceNote: string;
      localPath: string;
      /** Link Bindings: canonical manifest key when it differs from localPath. */
      manifestPath?: string;
      /** Resolved path with pathMapping (when known). */
      resolvedFsPath?: string;
      syncStatus?: string;
      /** machineId currently soft-locking this file (editingBy from manifest, excluding self). */
      editingBy?: string;
      editingByName?: string;
      /** Label override — canonical basename in canonical mode. */
      displayName?: string;
    };

function shortWorkspaceId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * Tracked files render as a folder tree by default; the flat list stays one
 * setting away for anyone who prefers seeing everything at once.
 */
function treeGroupingEnabled(): boolean {
  return vscode.workspace.getConfiguration("vscodesync").get<boolean>("tree.groupFilesByFolder", true);
}

export class WorkspacesTreeProvider implements vscode.TreeDataProvider<SyncTreeElement>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<SyncTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private workspaceJsonWatchDisposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Trims only; matching uses lowercase includes on note + id. Empty = no filter. */
  private _noteFilterRaw = "";
  private _noteFilterNorm = "";

  /** Tag filters (AND). Display form; match is case-insensitive exact per tag value. */
  private _tagFilters: string[] = [];

  /** If false, workspaces tagged `archived` are hidden unless tag filter includes archived or this flag is on. */
  private _showArchived = false;

  /**
   * Canonical mode: the tree groups by the WORKSPACE's own paths — the space
   * canonical-path edits and seeding live in — instead of this machine's
   * placement; the ⇄ badge flips to point at the local placement.
   *
   * On by default: the workspace tree should show the workspace, i.e. what a
   * second machine receives when it seeds. Grouping by local placement made a
   * cloud restructure look like it had not happened at all (the bytes never
   * move — only keys do). For an unbound file both spaces are identical, so
   * the common case looks the same either way.
   */
  private _canonicalMode = true;

  getCanonicalMode(): boolean {
    return this._canonicalMode;
  }

  setCanonicalMode(v: boolean): void {
    if (this._canonicalMode === v) return;
    this._canonicalMode = v;
    this.refresh();
  }

  /** Имя машины из globalConfig — для pathMapping при построении дерева файлов. */
  private _machineName: string | undefined;

  /** Для подписи «сейчас (вы)» в блоке машин. */
  private _localMachineId: string | undefined;

  /** Из globalConfig — скрывать workspace'ы с другим `providerType` в манифесте. `null` = не фильтровать. */
  private _activeCloudProvider: ProviderType | null = null;

  /** Workspace IDs currently being connected/synced — show spinner in tree. */
  private readonly _loadingWorkspaceIds = new Set<string>();

  /**
   * Workspace IDs that are being deleted from cloud right now (optimistic hide).
   * Filtered out of both active and remote-offer sections until the operation settles.
   */
  private readonly _pendingDeleteIds = new Set<string>();

  /** When set, root adds «Доступные на облаке» with workspaces not attached locally (see SyncEngine.listRemoteWorkspaceSummaries). */
  private _fetchRemoteSummaries?: () => Promise<{ workspaceId: string; workspaceNote: string }[]>;

  /** Cached result of _fetchRemoteSummaries to avoid a cloud round-trip on every tree refresh. */
  private _remoteSummariesCache: { summaries: { workspaceId: string; workspaceNote: string }[]; expiresAt: number } | undefined;

  /** Prevents concurrent background revalidation fetches. */
  private _remoteSummariesRevalidating = false;

  /** TTL for remote summaries cache in ms. */
  private static readonly REMOTE_CACHE_TTL_MS = 8_000;

  constructor() {
    this.rebindWorkspaceJsonWatchers();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rebindWorkspaceJsonWatchers();
        this.refresh();
      }),
    );
  }

  /**
   * Injected after activation when registry/engine deps exist.
   * Pass undefined to hide remote section.
   */
  setFetchRemoteSummaries(
    fn: (() => Promise<{ workspaceId: string; workspaceNote: string }[]>) | undefined,
  ): void {
    this._fetchRemoteSummaries = fn;
    this._remoteSummariesCache = undefined;
    this.refresh();
  }

  /**
   * Invalidates the remote summaries cache so the next tree render fetches fresh data.
   * Call after cloud operations that change the set of remote workspaces (attach, delete).
   */
  invalidateRemoteCache(): void {
    this._remoteSummariesCache = undefined;
  }

  /**
   * Optimistically hides a workspace from all tree sections while a cloud delete is in flight.
   * Must be paired with clearPendingDelete() when the operation settles.
   *
   * B6 — also invalidates the remote-summaries cache (TTL was 8s) and fires
   * a refresh so the deleted workspace doesn't linger in either active or
   * cloud-offers section while the cache TTL ticks down.
   */
  markPendingDelete(workspaceId: string): void {
    this._pendingDeleteIds.add(workspaceId);
    this.invalidateRemoteCache();
    this.refresh();
  }

  /**
   * Removes the workspace from the pending-delete set.
   * Call on both success and failure paths after cloud delete settles.
   *
   * Also invalidates the remote cache so the next refresh fetches the
   * authoritative state from the cloud (cleared whether delete succeeded
   * or failed; the cloud is the source of truth).
   */
  clearPendingDelete(workspaceId: string): void {
    this._pendingDeleteIds.delete(workspaceId);
    this.invalidateRemoteCache();
    this.refresh();
  }

  private rebindWorkspaceJsonWatchers(): void {
    for (const d of this.workspaceJsonWatchDisposables) {
      d.dispose();
    }
    this.workspaceJsonWatchDisposables = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, ".vscode/vscodesync.json");
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      this.workspaceJsonWatchDisposables.push(
        w,
        w.onDidChange(() => {
          this.refresh();
        }),
        w.onDidCreate(() => {
          this.refresh();
        }),
        w.onDidDelete(() => {
          this.refresh();
        }),
      );
    }
  }

  refresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this._onDidChange.fire(undefined);
    }, 150);
  }

  getNoteFilter(): string {
    return this._noteFilterRaw;
  }

  /**
   * Updates workspace list filter (by note / id). Does not persist; caller stores in globalState if needed.
   */
  setNoteFilter(raw: string): void {
    const next = raw.trim();
    const norm = next.toLowerCase();
    if (next === this._noteFilterRaw && norm === this._noteFilterNorm) {
      return;
    }
    this._noteFilterRaw = next;
    this._noteFilterNorm = norm;
    this.refresh();
  }

  getTagFilters(): readonly string[] {
    return this._tagFilters;
  }

  setTagFilters(next: string[]): void {
    const norm = new Map<string, string>();
    for (const t of next) {
      const tr = t.trim();
      if (!tr) {
        continue;
      }
      const low = tr.toLowerCase();
      if (!norm.has(low)) {
        norm.set(low, tr);
      }
    }
    const merged = [...norm.values()];
    if (
      merged.length === this._tagFilters.length &&
      merged.every((v, i) => v === this._tagFilters[i])
    ) {
      return;
    }
    this._tagFilters = merged;
    this.refresh();
  }

  getShowArchived(): boolean {
    return this._showArchived;
  }

  setLocalMachineIdentity(machineId: string, machineName?: string): void {
    if (this._localMachineId === machineId && this._machineName === machineName) {
      return;
    }
    this._localMachineId = machineId;
    this._machineName = machineName;
    this.refresh();
  }

  setActiveCloudProvider(t: ProviderType | null): void {
    if (t === this._activeCloudProvider) {
      return;
    }
    this._activeCloudProvider = t;
    this.refresh();
  }

  setShowArchived(v: boolean): void {
    if (v === this._showArchived) {
      return;
    }
    this._showArchived = v;
    this.refresh();
  }

  setWorkspaceLoading(workspaceId: string, loading: boolean): void {
    if (loading) {
      this._loadingWorkspaceIds.add(workspaceId);
    } else {
      this._loadingWorkspaceIds.delete(workspaceId);
    }
    // No automatic refresh — caller is responsible for calling refresh() at the right time.
  }

  isWorkspaceLoading(workspaceId: string): boolean {
    return this._loadingWorkspaceIds.has(workspaceId);
  }

  private workspaceMatchesNote(note: string, workspaceId: string): boolean {
    if (this._noteFilterNorm.length === 0) {
      return true;
    }
    const n = note.trim().toLowerCase();
    const id = workspaceId.toLowerCase();
    const shortId = id.length <= 8 ? id : id.slice(0, 8);
    return (
      n.includes(this._noteFilterNorm) ||
      id.includes(this._noteFilterNorm) ||
      shortId.includes(this._noteFilterNorm)
    );
  }

  private isHiddenAsArchived(tags: string[] | undefined): boolean {
    const lows = (tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    if (!lows.includes("archived")) {
      return false;
    }
    if (this._showArchived) {
      return false;
    }
    if (this._tagFilters.some((t) => t.trim().toLowerCase() === "archived")) {
      return false;
    }
    return true;
  }

  private matchesAllTagFilters(tags: string[] | undefined): boolean {
    if (this._tagFilters.length === 0) {
      return true;
    }
    const tset = new Set(
      (tags ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    );
    return this._tagFilters.every((f) => tset.has(f.trim().toLowerCase()));
  }

  private workspaceRowVisible(e: {
    workspaceNote: string;
    workspaceId: string;
    tags?: string[];
    providerType?: ProviderType;
  }): boolean {
    if (
      this._activeCloudProvider != null &&
      e.providerType != null &&
      e.providerType !== this._activeCloudProvider
    ) {
      return false;
    }
    if (this.isHiddenAsArchived(e.tags)) {
      return false;
    }
    if (!this.workspaceMatchesNote(e.workspaceNote, e.workspaceId)) {
      return false;
    }
    if (!this.matchesAllTagFilters(e.tags)) {
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this._onDidChange.dispose();
    for (const d of this.workspaceJsonWatchDisposables) {
      d.dispose();
    }
    this.workspaceJsonWatchDisposables = [];
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  getTreeItem(element: SyncTreeElement): vscode.TreeItem {
    if (element.kind === "fileFolder") {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `dir:${element.folderRoot.fsPath}:${element.workspaceId}:${element.localPrefix}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.resourceUri = vscode.Uri.file(
        path.join(element.folderRoot.fsPath, ...element.localPrefix.split("/")),
      );
      // One badge per folder instead of one per file: `⇄ canonical/prefix`
      // explains at a glance why this folder syncs under another name.
      const canonSpace = element.space === "canonical";
      const parts = [`${String(element.fileCount)} файл(ов)`];
      if (element.missingCount > 0) {
        parts.push(`${String(element.missingCount)} нет на диске`);
      }
      if (element.canonicalPrefix !== undefined) {
        parts.push(`⇄ ${element.canonicalPrefix}`);
      }
      item.description = parts.join(" · ");
      item.tooltip =
        element.canonicalPrefix !== undefined
          ? `${element.workspaceNote}\n${element.localPrefix}\n⇄ ${canonSpace ? "у меня" : "в облаке"}: ${element.canonicalPrefix}`
          : `${element.workspaceNote}\n${element.localPrefix}`;
      item.contextValue =
        element.canonicalPrefix !== undefined ? "vscodeSync.fileFolderBound" : "vscodeSync.fileFolder";
      return item;
    }

    if (element.kind === "rootFolder") {
      const item = new vscode.TreeItem(element.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "vscodeSync.rootFolder";
      item.id = `root:${element.folder.uri.fsPath}`;
      return item;
    }

    if (element.kind === "workspace") {
      const isLoading = this._loadingWorkspaceIds.has(element.workspaceId);
      const syncPrefix =
        element.syncState === "frozen" ? "🔒 " : element.syncState === "suspended" ? "⏸ " : "";
      const item = new vscode.TreeItem(
        `${syncPrefix}${workspaceHealthEmoji(element.health.level)} ${element.note || element.workspaceId}`,
        isLoading ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const tagPart =
        element.tags.length > 0
          ? ` · ${element.tags
              .slice(0, 3)
              .map((t) => `#${t}`)
              .join(" ")}${element.tags.length > 3 ? "…" : ""}`
          : "";
      if (isLoading) {
        item.description = "синхронизация...";
        item.iconPath = new vscode.ThemeIcon("sync~spin");
        item.contextValue = "vscodeSync.workspaceLoading";
      } else {
        // Which path space the children are grouped by is not guessable from
        // the paths themselves once the structures diverge — say it.
        const spacePart = this._canonicalMode ? "" : " · как у меня";
        item.description = `${shortWorkspaceId(element.workspaceId)}${tagPart}${spacePart}`.slice(0, 96);
        item.iconPath = new vscode.ThemeIcon(
          "cloud",
          workspaceHealthThemeColor(element.health.level),
        );
        item.contextValue = workspaceTreeContextValue(element.syncState, element.tags);
      }
      item.id = `ws:${element.folderRoot.fsPath}:${element.workspaceId}`;
      const tagLine =
        element.tags.length > 0 ? `\n\nТеги: ${element.tags.map((t) => `\`${t}\``).join(", ")}` : "";
      const healthBlock =
        element.health.summaryLines.length > 0
          ? `\n\n**Состояние (локально)**\n\n${element.health.summaryLines.map((l) => `- ${l}`).join("\n")}`
          : "";
      const machLines = formatMachinePresenceLines(element.manifestMachines, this._localMachineId);
      const machBlock = `\n\n**Машины (lastSeen в манифесте)**\n\n${machLines.map((l) => `- ${l}`).join("\n")}`;
      const spaceBlock = this._canonicalMode
        ? "\n\nФайлы показаны структурой воркспейса — по ней раскладываются другие машины при засеве."
        : "\n\nФайлы показаны так, как лежат на этой машине. Структура воркспейса может отличаться — переключатель ⇄ в заголовке панели.";
      item.tooltip = new vscode.MarkdownString(
        `**${element.note}**\n\n\`${element.workspaceId}\`\n\n${element.folderRoot.fsPath}${spaceBlock}${tagLine}${healthBlock}${machBlock}`,
      );
      return item;
    }

    if (element.kind === "cloudSection") {
      const item = new vscode.TreeItem("Доступные на облаке", vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("cloud-download");
      item.contextValue = "vscodeSync.cloudSection";
      item.id = `cloud:${element.anchorFolder.fsPath}`;
      item.tooltip = new vscode.MarkdownString(
        "Workspace'ы на активном провайдере, которые ещё не подключены ни к одной открытой папке.",
      );
      return item;
    }

    if (element.kind === "remoteOffer") {
      const isLoading = this._loadingWorkspaceIds.has(element.workspaceId);
      const title =
        element.workspaceNote.trim().length > 0 ? element.workspaceNote.trim() : element.workspaceId;
      const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
      if (isLoading) {
        item.description = "синхронизация...";
        item.iconPath = new vscode.ThemeIcon("sync~spin");
        item.contextValue = "vscodeSync.remoteOfferLoading";
      } else {
        item.description = shortWorkspaceId(element.workspaceId);
        item.iconPath = new vscode.ThemeIcon("cloud");
        item.contextValue = "vscodeSync.remoteOffer";
        item.command = {
          command: "vscodesync.treeRemoteWorkspaceConnect",
          title: "Connect",
          arguments: [element],
        };
      }
      item.id = `remote:${element.anchorFolder.fsPath}:${element.workspaceId}`;
      item.tooltip = new vscode.MarkdownString(
        `**${element.workspaceNote}**\n\n\`${element.workspaceId}\`\n\nПодключение добавляет workspace в локальный кэш «${element.anchorFolder.fsPath}» и синхронизирует состав файлов из манифеста.`,
      );
      return item;
    }

    const basename =
      element.displayName ??
      (element.localPath.includes("/")
        ? element.localPath.slice(element.localPath.lastIndexOf("/") + 1)
        : element.localPath);
    const abs =
      element.resolvedFsPath ??
      path.join(element.folderRoot.fsPath, ...element.localPath.split("/"));
    const item = new vscode.TreeItem(basename, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(abs);
    item.id = `file:${element.folderRoot.fsPath}:${element.workspaceId}:${element.localPath}`;
    const st = element.syncStatus;
    if (element.editingBy) {
      // Soft lock: another machine is editing this file; auto-push is blocked
      const who = element.editingByName ?? element.editingBy;
      item.description = `✏️ ${who}`;
      item.tooltip = `${element.workspaceNote}\n${element.localPath}\n\n✏️ Редактируется на '${who}'\n⚠️ Авто-синхронизация заблокирована. Используйте «Force Sync» для принудительной отправки.`;
      item.iconPath = new vscode.ThemeIcon("edit");
      item.contextValue = "vscodeSync.fileLocked";
    } else if (st === "conflict") {
      item.description = "conflict";
      item.iconPath = new vscode.ThemeIcon("warning");
      item.contextValue = "vscodeSync.fileConflict";
    } else if (st === "pending_push") {
      item.description = "pending push";
      item.iconPath = new vscode.ThemeIcon("arrow-up");
      item.contextValue = "vscodeSync.filePending";
    } else if (st === "cloud_newer") {
      item.description = "облако новее";
      item.iconPath = new vscode.ThemeIcon("arrow-down");
      item.tooltip = `${element.workspaceNote}\n${element.localPath}\n\nОблако содержит более новую версию.\nНажмите ПКМ → «Получить файл» для обновления.`;
      item.contextValue = "vscodeSync.file";
    } else if (st === "missing_local") {
      // Link Bindings: tracked, absent on disk — an honest state of its own.
      // The `vscodeSync.file` prefix keeps the shared menu (Pull works; Push
      // errors politely); binding row-actions target `fileMissing` explicitly.
      item.description = "нет на диске";
      item.iconPath = new vscode.ThemeIcon("close");
      item.contextValue = "vscodeSync.fileMissing";
    } else {
      item.contextValue = "vscodeSync.file";
    }
    const bound = element.manifestPath !== undefined && element.manifestPath !== element.localPath;
    if (bound) {
      // Link Bindings badge: without it "rename in cloud" asking about every
      // machine reads as a bug — the canonical name must be visible.
      item.description = [item.description, `⇄ ${element.manifestPath ?? ""}`].filter(Boolean).join(" · ");
    }
    item.tooltip = bound
      ? `${element.workspaceNote}\n${element.localPath}\n⇄ в облаке: ${element.manifestPath ?? ""}`
      : `${element.workspaceNote}\n${element.localPath}`;
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [vscode.Uri.file(abs)],
    };
    return item;
  }

  async getChildren(element?: SyncTreeElement): Promise<SyncTreeElement[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return [];
    }

    if (!element) {
      if (folders.length === 1) {
        const active = await this.workspacesUnderFolder(folders[0]);
        const cloud = await this.buildCloudSectionElements(folders[0].uri);
        return [...active, ...cloud];
      }
      const roots: SyncTreeElement[] = [];
      for (const folder of folders) {
        roots.push({ kind: "rootFolder" as const, folder });
      }
      return roots;
    }

    if (element.kind === "rootFolder") {
      const active = await this.workspacesUnderFolder(element.folder);
      const cloud = await this.buildCloudSectionElements(element.folder.uri);
      return [...active, ...cloud];
    }

    if (element.kind === "workspace") {
      return await this.filesUnderWorkspace(element);
    }

    if (element.kind === "fileFolder") {
      return await this.filesUnderWorkspace(
        {
          kind: "workspace",
          folderRoot: element.folderRoot,
          workspaceId: element.workspaceId,
          note: element.workspaceNote,
          tags: [],
          manifestMachines: [],
          // Only `folderRoot`/`workspaceId`/`note` are read below; health is a
          // required field of the workspace shape, never rendered from here.
          health: { level: "noData", summaryLines: [] },
        },
        element.localPrefix,
      );
    }

    if (element.kind === "cloudSection") {
      return element.offers.map((o) => ({
        kind: "remoteOffer" as const,
        anchorFolder: element.anchorFolder,
        workspaceId: o.workspaceId,
        workspaceNote: o.workspaceNote,
      }));
    }

    return [];
  }

  /**
   * Revalidates remote summaries in the background (stale-while-revalidate).
   * Never awaited by the tree render path — tree stays responsive.
   */
  private revalidateRemoteSummariesInBackground(): void {
    if (this._remoteSummariesRevalidating || !this._fetchRemoteSummaries) {
      return;
    }
    this._remoteSummariesRevalidating = true;
    void this._fetchRemoteSummaries()
      .then((summaries) => {
        this._remoteSummariesCache = { summaries, expiresAt: Date.now() + WorkspacesTreeProvider.REMOTE_CACHE_TTL_MS };
        this.refresh();
      })
      .catch(() => { /* keep stale cache on error */ })
      .finally(() => { this._remoteSummariesRevalidating = false; });
  }

  private async buildCloudSectionElements(anchor: vscode.Uri): Promise<SyncTreeElement[]> {
    if (!this._fetchRemoteSummaries) {
      return [];
    }

    const now = Date.now();
    let summaries: { workspaceId: string; workspaceNote: string }[];

    if (this._remoteSummariesCache) {
      // Return cached data immediately — never block the tree on a network call.
      summaries = this._remoteSummariesCache.summaries;
      if (this._remoteSummariesCache.expiresAt <= now) {
        // Cache is stale — revalidate in background; tree will refresh when done.
        this.revalidateRemoteSummariesInBackground();
      }
    } else {
      // No cache yet — kick off background fetch and return empty section for now.
      this.revalidateRemoteSummariesInBackground();
      return [];
    }
    const attached = await this.collectAttachedWorkspaceIds();
    const offers = summaries
      .filter((s) => !attached.has(s.workspaceId))
      .filter((s) => !this._pendingDeleteIds.has(s.workspaceId))
      .filter((s) => this.workspaceMatchesNote(s.workspaceNote, s.workspaceId));
    if (offers.length === 0) {
      return [];
    }
    return [{ kind: "cloudSection", anchorFolder: anchor, offers }];
  }

  private async collectAttachedWorkspaceIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      for (const w of wc.activeWorkspaces) {
        ids.add(w.workspaceId);
      }
    }
    return ids;
  }

  private async workspacesUnderFolder(folder: vscode.WorkspaceFolder): Promise<SyncTreeElement[]> {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    // Pre-compute lastSync per workspace once: max(file.lastSync) within the workspace.
    const lastSyncByWs = new Map<string, string>();
    for (const f of wc.files) {
      if (!f.lastSync) continue;
      const cur = lastSyncByWs.get(f.workspaceId) ?? "";
      if (f.lastSync > cur) lastSyncByWs.set(f.workspaceId, f.lastSync);
    }
    const visible = wc.activeWorkspaces
      .filter((e) => this.workspaceRowVisible(e))
      .filter((e) => !this._pendingDeleteIds.has(e.workspaceId));
    // Sort by recent activity (lastSync desc); workspaces without activity fall
    // to the end alphabetically so the list stays stable.
    visible.sort((a, b) => {
      const la = lastSyncByWs.get(a.workspaceId) ?? "";
      const lb = lastSyncByWs.get(b.workspaceId) ?? "";
      if (la && lb) return la < lb ? 1 : la > lb ? -1 : 0;
      if (la) return -1;
      if (lb) return 1;
      return a.workspaceNote.localeCompare(b.workspaceNote);
    });
    return visible.map((e) => {
      const health = workspaceHealthFromLocalCfg(wc, e.workspaceId);
      return {
        kind: "workspace" as const,
        folderRoot: folder.uri,
        workspaceId: e.workspaceId,
        note: e.workspaceNote,
        tags: e.tags ?? [],
        manifestMachines: e.manifestMachines ?? [],
        health,
        syncState: e.syncState,
      };
    });
  }

  /**
   * Children of a workspace (`parentPrefix === undefined`) or of a folder node.
   * Grouping lives in `planFileTreeChildren` (pure); this only turns nodes into
   * tree elements. Flat mode keeps the pre-tree rendering for anyone who wants
   * the whole list at once.
   */
  private async filesUnderWorkspace(
    ws: Extract<SyncTreeElement, { kind: "workspace" }>,
    parentPrefix?: string,
  ): Promise<SyncTreeElement[]> {
    const wc = await WorkspaceConfigManager.load(ws.folderRoot.fsPath);
    const rows = wc.files.filter((f) => f.workspaceId === ws.workspaceId);
    const note = wc.activeWorkspaces.find((a) => a.workspaceId === ws.workspaceId)?.workspaceNote ?? ws.note;
    const mn = this._machineName ?? "";
    const canonical = this._canonicalMode;
    const toFileElement = (
      src: (typeof rows)[number] | undefined,
      fallbackLocalPath: string,
      displayName?: string,
    ): SyncTreeElement => {
      const localPath = src?.localPath ?? fallbackLocalPath;
      let resolvedFsPath: string | undefined;
      try {
        resolvedFsPath = trackedLocalAbsolutePath(ws.folderRoot.fsPath, wc.pathMapping, mn, localPath);
      } catch {
        resolvedFsPath = undefined;
      }
      return {
        kind: "file" as const,
        folderRoot: ws.folderRoot,
        workspaceId: ws.workspaceId,
        workspaceNote: note,
        localPath,
        manifestPath: src?.manifestPath,
        resolvedFsPath,
        syncStatus: src?.syncStatus,
        editingBy: src?.editingBy,
        editingByName: src?.editingByName,
        ...(displayName !== undefined ? { displayName } : {}),
      };
    };

    // Canonical mode flips the grouping space: the tree shows the WORKSPACE's
    // own structure (the space path edits and seeding live in), and the ⇄
    // badge points back at this machine's placement instead.
    const planRows = canonical
      ? rows.map((f) => {
          const key = f.manifestPath ?? f.localPath;
          return {
            ...f,
            localPath: key,
            manifestPath: key === f.localPath ? undefined : f.localPath,
          };
        })
      : rows;

    // `groupFilesByFolder: false` means a flat list in EITHER space — the
    // setting is about grouping, not about which paths are shown.
    if (parentPrefix === undefined && !treeGroupingEnabled()) {
      return planRows.map((f, i) => toFileElement(rows[i], f.localPath, canonical ? f.localPath : undefined));
    }
    const byPlanPath = new Map(planRows.map((f, i) => [f.localPath, rows[i]]));
    return planFileTreeChildren(planRows, parentPrefix ?? "").map((node) =>
      node.kind === "file"
        ? toFileElement(
            byPlanPath.get(node.localPath),
            node.localPath,
            canonical ? node.name : undefined,
          )
        : {
            kind: "fileFolder" as const,
            folderRoot: ws.folderRoot,
            workspaceId: ws.workspaceId,
            workspaceNote: note,
            localPrefix: node.localPrefix,
            name: node.name,
            fileCount: node.fileCount,
            missingCount: node.missingCount,
            // In canonical mode the planner's "canonical" side is the swapped
            // one — this machine's placement; consumers key off `space`.
            canonicalPrefix: node.canonicalPrefix,
            space: canonical ? ("canonical" as const) : ("local" as const),
          },
    );
  }
}
