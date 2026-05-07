import { describe, expect, it } from "vitest";
import { buildSankeyLayout } from "../../src/core/sankeyLayout.js";

describe("sankeyLayout", () => {
  it("returns empty layout for no flows", () => {
    const l = buildSankeyLayout([], { width: 400, height: 200 });
    expect(l.nodes).toHaveLength(0);
    expect(l.links).toHaveLength(0);
  });

  it("ignores non-positive / non-finite weights", () => {
    const l = buildSankeyLayout(
      [
        { source: "a", target: "b", weight: 0 },
        { source: "a", target: "b", weight: -3 },
        { source: "a", target: "b", weight: Number.NaN },
      ],
      { width: 400, height: 200 },
    );
    expect(l.nodes).toHaveLength(0);
    expect(l.links).toHaveLength(0);
  });

  it("places sources on the left column and targets on the right", () => {
    const l = buildSankeyLayout(
      [
        { source: "alpha", target: "beta", weight: 5 },
        { source: "alpha", target: "gamma", weight: 5 },
        { source: "delta", target: "beta", weight: 10 },
      ],
      { width: 400, height: 200 },
    );
    const sources = l.nodes.filter((n) => n.side === "source");
    const targets = l.nodes.filter((n) => n.side === "target");
    expect(sources.map((n) => n.id).sort()).toEqual(["alpha", "delta"]);
    expect(targets.map((n) => n.id).sort()).toEqual(["beta", "gamma"]);
    for (const s of sources) expect(s.x).toBe(0);
    for (const t of targets) expect(t.x).toBeGreaterThan(0);
  });

  it("orders nodes by total weight desc, ties broken by id", () => {
    const l = buildSankeyLayout(
      [
        { source: "a", target: "x", weight: 1 },
        { source: "b", target: "y", weight: 5 },
        { source: "c", target: "z", weight: 5 },
      ],
      { width: 400, height: 200 },
    );
    const sources = l.nodes.filter((n) => n.side === "source");
    expect(sources[0]?.id).toBe("b");
    expect(sources[1]?.id).toBe("c");
    expect(sources[2]?.id).toBe("a");
  });

  it("produces one link per flow with proportional thickness", () => {
    const l = buildSankeyLayout(
      [
        { source: "a", target: "x", weight: 30 },
        { source: "a", target: "y", weight: 10 },
      ],
      { width: 400, height: 200 },
    );
    expect(l.links).toHaveLength(2);
    const [big, small] = l.links as [(typeof l.links)[number], (typeof l.links)[number]];
    expect(big.thickness).toBeGreaterThan(small.thickness);
  });

  it("emits a cubic Bezier path string for every link", () => {
    const l = buildSankeyLayout(
      [{ source: "a", target: "b", weight: 1 }],
      { width: 200, height: 100 },
    );
    const [first] = l.links as [(typeof l.links)[number]];
    expect(first.path).toMatch(/^M .+ C .+,.+,.+$/);
  });

  it("clamps to non-negative width / height inputs", () => {
    const l = buildSankeyLayout([{ source: "a", target: "b", weight: 1 }], {
      width: 0,
      height: 0,
    });
    expect(l.width).toBe(1);
    expect(l.height).toBe(1);
  });
});
