import { describe, it, expect } from "vitest";
import {
  validateReadOnlySql,
  planAnalyticsQuery,
  AnalyticsBackendNotImplementedError,
} from "../../src/core/analyticsQueryShape.js";

describe("validateReadOnlySql", () => {
  it("accepts a simple SELECT", () => {
    expect(validateReadOnlySql("SELECT * FROM activity LIMIT 10")).toEqual({ ok: true });
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateReadOnlySql("")).toEqual({ ok: false, reason: "empty_sql" });
    expect(validateReadOnlySql("   \n\t  ")).toEqual({ ok: false, reason: "empty_sql" });
  });

  it("rejects DML / DDL keywords", () => {
    for (const sql of [
      "INSERT INTO activity VALUES (1)",
      "UPDATE stats SET v = 0",
      "DELETE FROM activity",
      "DROP TABLE x",
      "TRUNCATE x",
      "ALTER TABLE x ADD COLUMN y INT",
      "CREATE TABLE x AS SELECT 1",
    ]) {
      const r = validateReadOnlySql(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("non_select_keyword_present");
    }
  });

  it("rejects unbalanced quotes", () => {
    expect(validateReadOnlySql("SELECT 'foo")).toEqual({ ok: false, reason: "unbalanced_quotes" });
    expect(validateReadOnlySql('SELECT "bar')).toEqual({ ok: false, reason: "unbalanced_quotes" });
  });

  it("ignores quote characters that appear inside the other quote pair", () => {
    expect(validateReadOnlySql(`SELECT 'has "double" inside'`)).toEqual({ ok: true });
  });

  it("rejects unclosed /* */ block comment", () => {
    expect(validateReadOnlySql("SELECT 1 /* comment")).toEqual({
      ok: false,
      reason: "comment_block_unclosed",
    });
  });
});

describe("planAnalyticsQuery", () => {
  it("propagates validation failure", () => {
    const r = planAnalyticsQuery({ sql: "DROP TABLE x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_select_keyword_present");
  });

  it("identifies required tables based on the SQL body", () => {
    const r = planAnalyticsQuery({ sql: "SELECT * FROM activity JOIN stats ON 1=1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requiredTables).toContain("activity");
      expect(r.requiredTables).toContain("stats");
      expect(r.requiredTables).not.toContain("snapshots");
    }
  });

  it("applies caller overrides + sane defaults", () => {
    const r = planAnalyticsQuery({ sql: "SELECT 1", timeoutMs: 1000, rowLimit: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.timeoutMs).toBe(1000);
      expect(r.rowLimit).toBe(5);
    }
    const def = planAnalyticsQuery({ sql: "SELECT 1" });
    expect(def.ok).toBe(true);
    if (def.ok) {
      expect(def.timeoutMs).toBe(5000);
      expect(def.rowLimit).toBe(10_000);
    }
  });
});

describe("AnalyticsBackendNotImplementedError", () => {
  it("carries the canonical code field", () => {
    expect(new AnalyticsBackendNotImplementedError().code).toBe("analytics_backend_not_implemented");
  });
});
