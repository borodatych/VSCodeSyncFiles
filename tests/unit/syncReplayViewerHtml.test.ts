import { describe, expect, it } from "vitest";
import {
  makeReplayCursor,
  type ReplayEvent,
} from "../../src/core/syncReplayPlayback.js";
import { renderSyncReplayViewerHtml } from "../../src/core/syncReplayViewerHtml.js";

const events: ReplayEvent[] = [
  { tsMs: 1_700_000_000_000, kind: "push", relPath: "a.ts", machineName: "alpha" },
  { tsMs: 1_700_000_001_000, kind: "pull", relPath: "b.ts", machineName: "beta" },
  { tsMs: 1_700_000_002_000, kind: "conflict", relPath: "c.ts" },
];

describe("renderSyncReplayViewerHtml — empty state", () => {
  it("renders a short empty-state message", () => {
    const html = renderSyncReplayViewerHtml([]);
    expect(html).toContain("No events to replay.");
    expect(html).toContain("vss-replay-empty");
  });
});

describe("renderSyncReplayViewerHtml — populated", () => {
  it("renders one <li> per event with timestamp + kind + machine + path", () => {
    const html = renderSyncReplayViewerHtml(events);
    const liOpenCount = (html.match(/<li class="vss-replay-row/g) ?? []).length;
    expect(liOpenCount).toBe(events.length);
    expect(html).toContain("alpha");
    expect(html).toContain("a.ts");
    expect(html).toContain("conflict");
  });

  it("dims rows past the cursor (vss-replay-future)", () => {
    const cursor = makeReplayCursor(events.length, 1);
    const html = renderSyncReplayViewerHtml(events, { cursor });
    // Row 0 is in the past (no future class), rows 1 and 2 are future.
    const futureCount = (html.match(/<li class="vss-replay-row vss-replay-future"/g) ?? []).length;
    expect(futureCount).toBe(2);
  });

  it("uses kind-specific colors from the default map", () => {
    const html = renderSyncReplayViewerHtml(events);
    expect(html).toContain("--vscode-charts-green");
    expect(html).toContain("--vscode-charts-blue");
  });

  it("supports color override per kind", () => {
    const html = renderSyncReplayViewerHtml([events[0]], {
      colorByKind: { push: "magenta" },
    });
    expect(html).toContain("background:magenta");
  });
});

describe("renderSyncReplayViewerHtml — XSS", () => {
  it("escapes user-controlled relPath / machineName", () => {
    const malicious: ReplayEvent[] = [
      {
        tsMs: 1_700_000_000_000,
        kind: "push",
        relPath: '<img src=x onerror="alert(1)">',
        machineName: "<script>",
      },
    ];
    const html = renderSyncReplayViewerHtml(malicious);
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a malicious title", () => {
    const html = renderSyncReplayViewerHtml([], {
      title: "<style>body{display:none}</style>",
    });
    expect(html).not.toContain("<style>body{display:none}</style>");
    expect(html).toContain("&lt;style&gt;");
  });
});
