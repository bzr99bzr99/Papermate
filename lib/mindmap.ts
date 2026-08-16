export interface MindMapNode {
  label: string;
  children: MindMapNode[];
}

export function markdownToMindMap(markdown: string, fallback = "论文结构"): MindMapNode {
  const root: MindMapNode = { label: fallback, children: [] };
  const stack: Array<{ depth: number; node: MindMapNode }> = [{ depth: -1, node: root }];
  const lines = markdown.split(/\r?\n/);

  for (const rawLine of lines) {
    const match = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
    if (!match) continue;
    const depth = Math.floor(match[1].replace(/\t/g, "  ").length / 2);
    const node: MindMapNode = { label: match[2].replace(/[*`]/g, "").trim(), children: [] };
    while (stack.length > 1 && stack.at(-1)!.depth >= depth) stack.pop();
    stack.at(-1)!.node.children.push(node);
    stack.push({ depth, node });
  }
  return root.children.length ? root : { label: fallback, children: [{ label: "等待生成脑图", children: [] }] };
}

interface NodeStyle {
  fill: string;
  stroke: string;
  text: string;
}

const palettes: NodeStyle[][] = [
  [
    { fill: "#24453c", stroke: "#17332b", text: "#f2f8e8" },
  ],
  [
    { fill: "#3f6a5c", stroke: "#2e5247", text: "#ffffff" },
    { fill: "#4d7c66", stroke: "#39634f", text: "#ffffff" },
    { fill: "#315a4b", stroke: "#24463a", text: "#eef6e8" },
  ],
  [
    { fill: "#b9d771", stroke: "#9bbb55", text: "#28331f" },
    { fill: "#c9e083", stroke: "#aac95f", text: "#2c371f" },
    { fill: "#a8c962", stroke: "#8aad4a", text: "#222d18" },
  ],
  [
    { fill: "#f2b98b", stroke: "#dd9a66", text: "#3d2a1a" },
    { fill: "#f5c9a3", stroke: "#e0a87c", text: "#43301f" },
    { fill: "#eaa976", stroke: "#d28c58", text: "#382618" },
  ],
  [
    { fill: "#9bc0e8", stroke: "#79a4d3", text: "#1f3243" },
    { fill: "#aed0f0", stroke: "#8ab5e4", text: "#24394c" },
    { fill: "#85afe0", stroke: "#6592c7", text: "#182c3f" },
  ],
  [
    { fill: "#d6aee0", stroke: "#bc8fd0", text: "#382a44" },
    { fill: "#e2c3ea", stroke: "#c7a1d9", text: "#412f4d" },
    { fill: "#c99bd8", stroke: "#ad7fc1", text: "#30233b" },
  ],
];

interface BoxedNode {
  node: MindMapNode;
  depth: number;
  sibling: number;
  w: number;
  h: number;
  lines: string[];
}

interface PlacedNode {
  boxed: BoxedNode;
  x: number;
  y: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)) width += 13.2;
    else width += 7.1;
  }
  return width;
}

function wrapLabel(label: string, maxWidth: number): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (!words.length) return ["…"];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  const result: string[] = [];
  for (const line of lines) {
    if (textWidth(line) <= maxWidth) {
      result.push(line);
      continue;
    }
    let rest = line;
    while (textWidth(rest) > maxWidth) {
      let cut = Math.floor(rest.length / 2);
      while (cut > 1 && textWidth(rest.slice(0, cut)) > maxWidth) cut -= 1;
      result.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) result.push(rest);
  }
  return result;
}

function boxFor(node: MindMapNode, depth: number, sibling: number): BoxedNode {
  const lines = wrapLabel(node.label || "未命名节点", 150);
  const lineWidth = Math.max(...lines.map(textWidth));
  const w = Math.min(220, Math.max(118, Math.ceil(lineWidth + 30)));
  const h = Math.max(38, lines.length * 16 + 14);
  return { node, depth, sibling, w, h, lines };
}

export function mindMapToSvg(root: MindMapNode): string {
  const pageLeft = 48;
  const pageRight = 48;
  const pageTop = 46;
  const colGap = 78;
  const rowGap = 12;
  const boxes = new Map<MindMapNode, BoxedNode>();
  const heights = new Map<MindMapNode, number>();
  const columnWidths = new Map<number, number>();
  let maxDepth = 0;

  const getBox = (node: MindMapNode, depth: number, sibling: number): BoxedNode => {
    const existing = boxes.get(node);
    if (existing) return existing;
    const boxed = boxFor(node, depth, sibling);
    boxes.set(node, boxed);
    columnWidths.set(depth, Math.max(columnWidths.get(depth) ?? 0, boxed.w));
    maxDepth = Math.max(maxDepth, depth);
    return boxed;
  };

  const heightOf = (node: MindMapNode, depth: number, sibling: number): number => {
    const cached = heights.get(node);
    if (cached !== undefined) return cached;
    const boxed = getBox(node, depth, sibling);
    let height = boxed.h;
    if (node.children.length) {
      let total = 0;
      node.children.forEach((child, index) => {
        total += heightOf(child, depth + 1, index);
        if (index > 0) total += rowGap;
      });
      height = Math.max(height, total);
    }
    heights.set(node, height);
    return height;
  };

  heightOf(root, 0, 0);

  const columnXs = new Map<number, number>();
  let x = pageLeft;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    columnXs.set(depth, x);
    x += colGap + (columnWidths.get(depth) ?? 160);
  }

  const placed: PlacedNode[] = [];
  const place = (node: MindMapNode, depth: number, sibling: number, top: number) => {
    const boxed = getBox(node, depth, sibling);
    const subtreeHeight = heightOf(node, depth, sibling);
    const left = columnXs.get(depth) ?? pageLeft;
    const y = top + (subtreeHeight - boxed.h) / 2;
    placed.push({ boxed, x: left, y });
    let childTop = top;
    node.children.forEach((child, index) => {
      place(child, depth + 1, index, childTop);
      childTop += heightOf(child, depth + 1, index) + rowGap;
    });
  };
  place(root, 0, 0, pageTop);

  const lastColumnWidth = columnWidths.get(maxDepth) ?? 160;
  const width = Math.max(560, (columnXs.get(maxDepth) ?? pageLeft) + lastColumnWidth + pageRight);
  const rootHeight = heights.get(root) ?? 120;
  const height = Math.max(190, pageTop * 2 + rootHeight);

  const styleFor = (boxed: BoxedNode): NodeStyle => {
    const family = palettes[Math.min(boxed.depth, palettes.length - 1)];
    return family[boxed.sibling % family.length];
  };

  const paths: string[] = [];
  const renderNode = (item: PlacedNode): string => {
    const { boxed, x: left, y: top } = item;
    const style = styleFor(boxed);
    const midX = left + boxed.w / 2;
    const midY = top + boxed.h / 2;
    if (boxed.node !== root) {
      // 父节点在 layout 中未直接记录，这里通过 children 反查
      for (const candidate of placed) {
        if (candidate.boxed.node.children.includes(boxed.node)) {
          const parentMidX = candidate.x + candidate.boxed.w;
          const parentMidY = candidate.y + candidate.boxed.h / 2;
          paths.push(
            `<path d="M ${parentMidX} ${parentMidY} C ${parentMidX + 40} ${parentMidY}, ${left - 40} ${midY}, ${left} ${midY}" fill="none" stroke="${style.stroke}" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>`,
          );
          break;
        }
      }
    }
    const firstLineY = midY - (boxed.lines.length - 1) * 8;
    const tspans = boxed.lines
      .map((line, index) => `<tspan x="${midX}" dy="${index === 0 ? 0 : 16}">${escapeXml(line)}</tspan>`)
      .join("");
    const shadow = boxed.depth <= 1 ? ' filter="url(#pm-shadow)"' : "";
    const fontSize = boxed.depth === 0 ? 15 : boxed.depth === 1 ? 13 : 11.5;
    const fontWeight = boxed.depth <= 1 ? 700 : 500;
    return (
      `<rect x="${left}" y="${top}" width="${boxed.w}" height="${boxed.h}" rx="${Math.min(13, boxed.h / 2)}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.4"${shadow}/>` +
      `<text x="${midX}" y="${firstLineY}" text-anchor="middle" dominant-baseline="central" font-family="'Plus Jakarta Sans','Noto Serif SC',system-ui,sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${style.text}">${tspans}</text>`
    );
  };

  const nodes = placed.map(renderNode).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="论文脑图">` +
    `<defs><linearGradient id="pm-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fdfcf8"/><stop offset="100%" stop-color="#edf2e5"/></linearGradient>` +
    `<filter id="pm-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2.5" stdDeviation="3.2" flood-color="#1c2a23" flood-opacity="0.18"/></filter></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="url(#pm-bg)"/>` +
    paths.join("") +
    nodes +
    `</svg>`
  );
}
