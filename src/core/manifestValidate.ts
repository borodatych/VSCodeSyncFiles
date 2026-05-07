/**
 * Lightweight runtime validation for `CloudManifest` shape.
 *
 * Goal: cheap pre-flight before PUT — catch accidental shape regressions
 * before they corrupt cloud state for other machines. We deliberately don't
 * pull in Zod/Ajv here: the schema is small, JSON.stringify already serialises
 * fine, and adding a dep for one validator is over-engineering.
 */
import type { CloudManifest, ManifestFile, MachineEntry } from "./cloudLayout.js";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

function validateMachine(m: unknown, ix: number): ValidationResult {
  if (typeof m !== "object" || m === null) return fail(`machines[${String(ix)}] not object`);
  const e = m as Partial<MachineEntry>;
  if (!isStr(e.machineId)) return fail(`machines[${String(ix)}].machineId not string`);
  if (!isStr(e.machineName)) return fail(`machines[${String(ix)}].machineName not string`);
  if (!isStr(e.lastSeen)) return fail(`machines[${String(ix)}].lastSeen not string`);
  return { ok: true };
}

function validateFile(f: unknown, ix: number): ValidationResult {
  if (typeof f !== "object" || f === null) return fail(`files[${String(ix)}] not object`);
  const e = f as Partial<ManifestFile>;
  if (!isStr(e.path) || e.path.length === 0) return fail(`files[${String(ix)}].path empty`);
  if (e.path.includes("\\")) return fail(`files[${String(ix)}].path contains backslash`);
  if (!isStr(e.addedAt)) return fail(`files[${String(ix)}].addedAt not string`);
  if (!isNum(e.version)) return fail(`files[${String(ix)}].version not finite number`);
  return { ok: true };
}

export type ParseResult = { ok: true; value: CloudManifest } | { ok: false; reason: string };

/**
 * Parse a manifest body buffer and validate shape in one step. Used by UI
 * commands (export wizard, restore wizard) where engine is not available.
 */
export function parseManifestSafe(body: Buffer): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (e) {
    return { ok: false, reason: `JSON parse: ${e instanceof Error ? e.message : String(e)}` };
  }
  const v = validateManifestShape(parsed);
  if (!v.ok) return v;
  return { ok: true, value: parsed as CloudManifest };
}

export function validateManifestShape(m: unknown): ValidationResult {
  if (typeof m !== "object" || m === null) return fail("manifest not object");
  const e = m as Partial<CloudManifest>;
  if (!isStr(e.workspaceId) || e.workspaceId.length === 0) return fail("workspaceId empty");
  if (!isNum(e.schemaVersion)) return fail("schemaVersion not number");
  if (!isStr(e.workspaceNote)) return fail("workspaceNote not string");
  if (!isStr(e.providerType)) return fail("providerType not string");
  if (!isStr(e.createdAt)) return fail("createdAt not string");
  if (!isStr(e.updatedAt)) return fail("updatedAt not string");
  if (!Array.isArray(e.files)) return fail("files not array");
  for (let i = 0; i < e.files.length; i++) {
    const r = validateFile(e.files[i], i);
    if (!r.ok) return r;
  }
  if (!Array.isArray(e.machines)) return fail("machines not array");
  for (let i = 0; i < e.machines.length; i++) {
    const r = validateMachine(e.machines[i], i);
    if (!r.ok) return r;
  }
  if (e.tags !== undefined && !isStringArray(e.tags)) return fail("tags not string[]");
  return { ok: true };
}
