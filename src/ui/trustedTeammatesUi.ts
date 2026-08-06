/**
 * v0.18 D06 — UI commands + global-state persistence for the
 * trusted-machines registry.
 *
 * Storage: VS Code `globalState` at `vscodesync.trustedMachines.v1`.
 * Cache: `core/trustedMachinesCache` — a module-level set the engine reads on
 * a hot path. It used to hang off `globalThis` under a `__vscodesync…` key,
 * where nothing declared who owned it (F7).
 */
import * as vscode from "vscode";
import {
  EMPTY_TRUSTED_REGISTRY,
  addTrusted,
  parseTrustedRegistry,
  removeTrusted,
  type TrustedMachinesRegistry,
} from "../core/trustedMachinesRegistry.js";
import { clearTrustedMachineIds, setTrustedMachineIds } from "../core/trustedMachinesCache.js";

const GLOBAL_STATE_KEY = "vscodesync.trustedMachines.v1";

function refreshCache(reg: TrustedMachinesRegistry): void {
  setTrustedMachineIds(reg.entries.map((e) => e.machineId));
}

function loadRegistry(context: vscode.ExtensionContext): TrustedMachinesRegistry {
  return parseTrustedRegistry(context.globalState.get(GLOBAL_STATE_KEY));
}

async function saveRegistry(
  context: vscode.ExtensionContext,
  reg: TrustedMachinesRegistry,
): Promise<void> {
  await context.globalState.update(GLOBAL_STATE_KEY, reg);
  refreshCache(reg);
}

export function registerTrustedTeammatesCommands(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  // Prime the cache so engineFactory sees latest registry from first call.
  refreshCache(loadRegistry(context));

  const out: vscode.Disposable[] = [];

  out.push(
    vscode.commands.registerCommand("vscodesync.addTrustedMachine", async () => {
      const id = await vscode.window.showInputBox({
        prompt: "machineId, который вы доверяете (из _machines.json или Status)",
        ignoreFocusOut: true,
      });
      if (!id) return;
      const label = await vscode.window.showInputBox({
        prompt: "Человеческое имя для этой машины (например, «Alice's Mac»)",
        value: id,
        ignoreFocusOut: true,
      });
      if (!label) return;
      const reg = loadRegistry(context);
      const next = addTrusted(reg, id.trim(), label.trim());
      await saveRegistry(context, next);
      void vscode.window.showInformationMessage(
        `VSCodeSync: машина «${label}» отмечена как доверенная. requireMachineApproval теперь пропускает её.`,
      );
    }),
  );

  out.push(
    vscode.commands.registerCommand("vscodesync.removeTrustedMachine", async () => {
      const reg = loadRegistry(context);
      if (reg.entries.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: нет доверенных машин.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        reg.entries.map((e) => ({
          label: e.label,
          description: e.machineId,
          detail: `Добавлена ${e.addedAtIso}`,
          mid: e.machineId,
        })),
        { placeHolder: "Снять доверие с машины" },
      );
      if (!picked) return;
      const next = removeTrusted(reg, picked.mid);
      await saveRegistry(context, next);
      void vscode.window.showInformationMessage(
        `VSCodeSync: машина «${picked.label}» больше не доверенная.`,
      );
    }),
  );

  out.push(
    vscode.commands.registerCommand("vscodesync.listTrustedMachines", async () => {
      const reg = loadRegistry(context);
      if (reg.entries.length === 0) {
        void vscode.window.showInformationMessage("VSCodeSync: список доверенных машин пуст.");
        return;
      }
      const items = reg.entries.map((e) =>
        `• ${e.label} (${e.machineId}) — добавлена ${e.addedAtIso}`,
      );
      await vscode.window.showInformationMessage(
        `Доверенные машины:\n${items.join("\n")}`,
        { modal: true },
      );
    }),
  );

  // Reset cache when registry is somehow tampered (e.g. user cleared
  // globalState manually).
  out.push(new vscode.Disposable(() => {
    clearTrustedMachineIds();
  }));

  void EMPTY_TRUSTED_REGISTRY; // re-export keeps tree-shake honest
  return out;
}
