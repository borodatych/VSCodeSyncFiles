/**
 * Persistent storage for named Activity Feed filters.
 *
 * Filter shape mirrors what the Activity Feed webview already exposes:
 * `kind` (push|pull|conflict|…|"any"), `workspaceId`, `query` (substring).
 * The webview consumes these via the `applySavedSearch` postMessage; absence
 * of the webview is fine — the QuickPick command opens the feed first.
 */
import * as vscode from "vscode";

export const STATE_KEY = "vscodesync.activity.savedSearches";

export interface SavedActivityFilter {
  kind?: string;
  workspaceId?: string;
  query?: string;
}

export interface SavedActivitySearch {
  id: string;
  name: string;
  filter: SavedActivityFilter;
}

interface SavedSearchesStore {
  schema: 1;
  items: SavedActivitySearch[];
}

function readStore(context: vscode.ExtensionContext): SavedSearchesStore {
  const raw = context.globalState.get<unknown>(STATE_KEY);
  if (
    raw !== null &&
    typeof raw === "object" &&
    (raw as { schema?: number }).schema === 1 &&
    Array.isArray((raw as { items?: unknown }).items)
  ) {
    return raw as SavedSearchesStore;
  }
  return { schema: 1, items: [] };
}

async function writeStore(
  context: vscode.ExtensionContext,
  store: SavedSearchesStore,
): Promise<void> {
  await context.globalState.update(STATE_KEY, store);
}

export function listSavedSearches(context: vscode.ExtensionContext): SavedActivitySearch[] {
  return readStore(context).items;
}

export async function upsertSavedSearch(
  context: vscode.ExtensionContext,
  name: string,
  filter: SavedActivityFilter,
): Promise<SavedActivitySearch> {
  const store = readStore(context);
  const trimmed = name.trim();
  const idx = store.items.findIndex((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  const id = idx >= 0 ? store.items[idx].id : Math.random().toString(36).slice(2, 10);
  const entry: SavedActivitySearch = { id, name: trimmed, filter };
  if (idx >= 0) {
    store.items[idx] = entry;
  } else {
    store.items.push(entry);
  }
  await writeStore(context, store);
  return entry;
}

export async function deleteSavedSearch(
  context: vscode.ExtensionContext,
  id: string,
): Promise<boolean> {
  const store = readStore(context);
  const next = store.items.filter((s) => s.id !== id);
  if (next.length === store.items.length) return false;
  store.items = next;
  await writeStore(context, store);
  return true;
}

/**
 * Last filter applied in the webview — used to "save current search" without
 * the webview round-tripping the form into the global state itself.
 */
const LAST_APPLIED_KEY = "vscodesync.activity.lastFilter";

export function getLastAppliedFilter(
  context: vscode.ExtensionContext,
): SavedActivityFilter | undefined {
  const raw = context.globalState.get<unknown>(LAST_APPLIED_KEY);
  if (raw !== null && typeof raw === "object") {
    return raw;
  }
  return undefined;
}

export async function setLastAppliedFilter(
  context: vscode.ExtensionContext,
  filter: SavedActivityFilter,
): Promise<void> {
  await context.globalState.update(LAST_APPLIED_KEY, filter);
}
