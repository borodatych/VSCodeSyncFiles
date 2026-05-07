/**
 * Vanilla two-column sankey layout (vscode-free, no D3).
 *
 * Aggregates a flow list into source / target nodes with heights proportional
 * to incoming / outgoing weight, then emits SVG-ready coordinates plus cubic
 * Bezier paths for each flow. The renderer (`sankeyChartPanel.ts`) only
 * concatenates strings.
 */

export interface SankeyFlowInput {
  source: string;
  target: string;
  weight: number;
}

export interface SankeyOptions {
  width: number;
  height: number;
  paddingTop?: number;
  paddingBottom?: number;
  columnWidth?: number;
  nodeGap?: number;
}

export interface SankeyNode {
  id: string;
  label: string;
  side: "source" | "target";
  x: number;
  y: number;
  width: number;
  height: number;
  total: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  weight: number;
  path: string;
  thickness: number;
  sourceY: number;
  targetY: number;
}

export interface SankeyLayout {
  width: number;
  height: number;
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export function buildSankeyLayout(flows: readonly SankeyFlowInput[], opts: SankeyOptions): SankeyLayout {
  const width = Math.max(opts.width, 1);
  const height = Math.max(opts.height, 1);
  const paddingTop = opts.paddingTop ?? 16;
  const paddingBottom = opts.paddingBottom ?? 16;
  const columnWidth = opts.columnWidth ?? 16;
  const nodeGap = opts.nodeGap ?? 6;

  const sourceTotals = new Map<string, number>();
  const targetTotals = new Map<string, number>();
  let grand = 0;
  for (const f of flows) {
    if (!Number.isFinite(f.weight) || f.weight <= 0) continue;
    sourceTotals.set(f.source, (sourceTotals.get(f.source) ?? 0) + f.weight);
    targetTotals.set(f.target, (targetTotals.get(f.target) ?? 0) + f.weight);
    grand += f.weight;
  }

  if (grand === 0) {
    return { width, height, nodes: [], links: [] };
  }

  const sources = [...sourceTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const targets = [...targetTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const usableHeight = Math.max(height - paddingTop - paddingBottom - nodeGap * (Math.max(sources.length, targets.length) - 1), 1);

  const nodes: SankeyNode[] = [];
  const sourceLayout = new Map<string, { x: number; y: number; height: number }>();
  const targetLayout = new Map<string, { x: number; y: number; height: number }>();

  let yCursor = paddingTop;
  for (const [id, total] of sources) {
    const h = Math.max((total / grand) * usableHeight, 2);
    const node: SankeyNode = {
      id,
      label: id,
      side: "source",
      x: 0,
      y: yCursor,
      width: columnWidth,
      height: h,
      total,
    };
    nodes.push(node);
    sourceLayout.set(id, { x: 0 + columnWidth, y: yCursor, height: h });
    yCursor += h + nodeGap;
  }

  yCursor = paddingTop;
  const targetX = width - columnWidth;
  for (const [id, total] of targets) {
    const h = Math.max((total / grand) * usableHeight, 2);
    const node: SankeyNode = {
      id,
      label: id,
      side: "target",
      x: targetX,
      y: yCursor,
      width: columnWidth,
      height: h,
      total,
    };
    nodes.push(node);
    targetLayout.set(id, { x: targetX, y: yCursor, height: h });
    yCursor += h + nodeGap;
  }

  // Track cumulative offsets per node so multiple links stack vertically.
  const sourceOffsets = new Map<string, number>();
  const targetOffsets = new Map<string, number>();

  // Render links in same order as input — gives stable visual diff for tests.
  const links: SankeyLink[] = [];
  for (const f of flows) {
    if (!Number.isFinite(f.weight) || f.weight <= 0) continue;
    const sLayout = sourceLayout.get(f.source);
    const tLayout = targetLayout.get(f.target);
    if (!sLayout || !tLayout) continue;
    const sTotal = sourceTotals.get(f.source);
    const tTotal = targetTotals.get(f.target);
    if (sTotal === undefined || tTotal === undefined || sTotal === 0 || tTotal === 0) continue;
    const sFrac = f.weight / sTotal;
    const tFrac = f.weight / tTotal;
    const sBand = sLayout.height * sFrac;
    const tBand = tLayout.height * tFrac;
    const sOffset = sourceOffsets.get(f.source) ?? 0;
    const tOffset = targetOffsets.get(f.target) ?? 0;
    const sourceY = sLayout.y + sOffset + sBand / 2;
    const targetY = tLayout.y + tOffset + tBand / 2;
    sourceOffsets.set(f.source, sOffset + sBand);
    targetOffsets.set(f.target, tOffset + tBand);
    const cx1 = sLayout.x + (tLayout.x - sLayout.x) * 0.5;
    const cx2 = sLayout.x + (tLayout.x - sLayout.x) * 0.5;
    const path = `M ${String(sLayout.x)} ${String(sourceY)} C ${String(cx1)} ${String(sourceY)}, ${String(cx2)} ${String(targetY)}, ${String(tLayout.x)} ${String(targetY)}`;
    links.push({
      source: f.source,
      target: f.target,
      weight: f.weight,
      path,
      thickness: Math.max((sBand + tBand) / 2, 1),
      sourceY,
      targetY,
    });
  }

  return { width, height, nodes, links };
}
