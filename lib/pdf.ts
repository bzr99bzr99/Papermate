import type {
  Conversation,
  HighlightColor,
  HighlightRegion,
  PaperSection,
  ParagraphBlock,
  ParsedPage,
  PdfTextItem,
  SelectionGroup,
  TextAnchor,
} from "@/lib/types";

export function shortHash(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function makeAnchor(
  paperId: string,
  page: ParsedPage,
  quote: string,
  start = page.text.indexOf(quote),
  section?: string,
  options: {
    blockIds?: string[];
    textItemStart?: number;
    textItemEnd?: number;
    textStartOffset?: number;
    textEndOffset?: number;
  } = {},
): TextAnchor {
  const normalized = quote.trim().replace(/\s+/g, " ");
  const safeStart = Math.max(0, start);
  const blockIds =
    options.blockIds ??
    page.blocks
      .filter((block) => block.start <= safeStart + normalized.length && block.end >= safeStart)
      .map((block) => block.id);
  return {
    id: `${paperId}:${page.page}:${safeStart}:${shortHash(normalized)}`,
    page: page.page,
    start: safeStart,
    end: safeStart + normalized.length,
    quote: normalized,
    hash: shortHash(normalized),
    section,
    blockIds,
    textItemStart: options.textItemStart,
    textItemEnd: options.textItemEnd,
    textStartOffset: options.textStartOffset,
    textEndOffset: options.textEndOffset,
  };
}

export interface AnchorExcerptParts {
  head: string;
  tail: string;
  truncated: boolean;
}

export function anchorExcerptParts(
  quote: string,
  head = 14,
  tail = 14,
): AnchorExcerptParts {
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (!normalized) return { head: "", tail: "", truncated: false };
  const limit = Math.max(1, head + tail + 1);
  if (normalized.length <= limit) {
    return { head: normalized, tail: "", truncated: false };
  }
  const safeHead = Math.max(1, Math.min(head, normalized.length - tail - 1));
  const safeTail = Math.max(1, Math.min(tail, normalized.length - safeHead - 1));
  return {
    head: normalized.slice(0, safeHead),
    tail: normalized.slice(-safeTail),
    truncated: true,
  };
}

export function formatAnchorExcerpt(quote: string, head = 28, tail = 28): string {
  const parts = anchorExcerptParts(quote, head, tail);
  if (!parts.head) return "";
  return parts.truncated ? `${parts.head}…${parts.tail}` : parts.head;
}

export function selectionGroupForAnchors(
  paperId: string,
  anchors: TextAnchor[],
): SelectionGroup | undefined {
  const unique = [
    ...new Map(anchors.map((anchor) => [anchor.id, anchor])).values(),
  ].sort((a, b) => a.page - b.page || a.start - b.start);
  if (!unique.length) return undefined;
  return {
    id: `${paperId}:group:${shortHash(unique.map((anchor) => anchor.id).join("|"))}`,
    paperId,
    anchors: unique,
  };
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "sage",
  "sky",
  "peach",
  "rose",
  "lilac",
  "butter",
];

export function defaultHighlightColor(index: number): HighlightColor {
  const normalized = Math.max(0, Math.floor(index));
  return HIGHLIGHT_COLORS[normalized % HIGHLIGHT_COLORS.length];
}

function conversationAnchors(conversation: Conversation): TextAnchor[] {
  if (conversation.selection?.anchors.length) {
    return conversation.selection.anchors;
  }
  return conversation.anchor ? [conversation.anchor] : [];
}

export function deriveHighlightRegions(
  conversations: Conversation[],
): HighlightRegion[] {
  const groups = new Map<string, Conversation[]>();
  const anchorsById = new Map<string, TextAnchor>();
  conversations.forEach((conversation) => {
    const anchors = conversationAnchors(conversation);
    if (!anchors.length || !conversation.turns.some((turn) => turn.role === "user")) {
      return;
    }
    for (const anchor of anchors) {
      anchorsById.set(anchor.id, anchor);
      const existing = groups.get(anchor.id);
      if (existing) existing.push(conversation);
      else groups.set(anchor.id, [conversation]);
    }
  });

  return [...groups.entries()]
    .map(([anchorId, items]) => {
      const latest = [...items].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )[0];
      const anchor = anchorsById.get(anchorId);
      if (!latest || !anchor) return undefined;
      return {
        id: `region:${anchorId}`,
        paperId: latest.paperId,
        anchor,
        conversationIds: [...new Set(items.map((item) => item.id))],
        color: latest.color ?? defaultHighlightColor(conversations.indexOf(latest)),
        updatedAt: items.reduce(
          (latestDate, item) =>
            item.updatedAt.localeCompare(latestDate) > 0
              ? item.updatedAt
              : latestDate,
          items[0]?.updatedAt ?? latest.updatedAt,
        ),
      };
    })
    .filter((region): region is HighlightRegion => Boolean(region))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const MAX_SELECTION_FRAGMENTS = 20;
export const MIN_READER_ZOOM = 0.5;
export const MAX_READER_ZOOM = 3;
export const READER_ZOOM_STEP = 0.1;

export function clampReaderZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_READER_ZOOM, Math.max(MIN_READER_ZOOM, value));
}

export function stepReaderZoom(value: number, direction: 1 | -1): number {
  const next = Math.round((clampReaderZoom(value) + direction * READER_ZOOM_STEP) * 10) / 10;
  return clampReaderZoom(next);
}

export interface PdfTextLine {
  text: string;
  top: number;
  x?: number;
  fontSize?: number;
  column?: number;
  hasEOL?: boolean;
  blockId?: string;
  itemIndexes?: number[];
}

export interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfOutlineNode[];
}

export interface PdfPageReference {
  num: number;
  gen: number;
}

export interface TextLineCluster {
  lines: PdfTextLine[];
  items: PdfTextItem[];
}

function normalizeTextItemTransform(item: PdfTextItem): [number, number, number, number, number, number] {
  const transform = item.transform.slice(0, 6) as [number, number, number, number, number, number];
  return transform.map((value) => Number(value) || 0) as [number, number, number, number, number, number];
}

/**
 * 将 PDF.js 的 token 流按视觉行和列聚类。列分割发生在同一行的 x 间隙处，
 * 因此不会把正文与页眉、或双栏文章的两列混成一个段落。
 */
export function textLinesFromItems(items: PdfTextItem[], pageWidth = 0): PdfTextLine[] {
  const normalized = items
    .map((item, itemIndex) => ({ item, itemIndex, transform: normalizeTextItemTransform(item) }))
    .filter(({ item }) => item.str.trim());
  if (!normalized.length) return [];

  const measuredPageWidth =
    pageWidth ||
    normalized.reduce(
      (widest, entry) =>
        Math.max(widest, entry.transform[4] + Math.max(entry.item.width || 0, 1)),
      0,
    );
  const sorted = [...normalized].sort(
    (a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
  );
  const clusters: Array<Array<typeof sorted[number]>> = [];

  for (const entry of sorted) {
    const y = entry.transform[5];
    const height = entry.item.height || entry.transform[3] || 8;
    const cluster = clusters.find((group) => {
      const sample = group[0];
      const sampleHeight = sample.item.height || sample.transform[3] || 8;
      const tolerance = Math.max(3.5, Math.min(sampleHeight, height, 16) * 0.55);
      return Math.abs(sample.transform[5] - y) <= tolerance;
    });
    if (cluster) cluster.push(entry);
    else clusters.push([entry]);
  }

  interface VisualLineGroup {
    entries: Array<(typeof sorted)[number]>;
    text: string;
    top: number;
    x: number;
    right: number;
    fontSize: number;
    hasEOL: boolean;
    clusterIndex: number;
    column?: number;
  }

  const makeVisualLineGroup = (
    entries: Array<(typeof sorted)[number]>,
    clusterIndex: number,
    column?: number,
  ): VisualLineGroup | undefined => {
    const text = entries
      .map(({ item }) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return undefined;
    const x = Math.min(...entries.map(({ transform }) => transform[4]));
    const right = Math.max(
      ...entries.map(({ item, transform }) =>
        transform[4] + Math.max(item.width || 0, 1),
      ),
    );
    const top = Math.max(...entries.map(({ transform }) => transform[5]));
    const fontSize = Math.max(
      ...entries.map(({ transform }) => Math.max(Math.abs(transform[0]), Math.abs(transform[3]))),
    );
    return {
      entries,
      text,
      top,
      x,
      right,
      fontSize,
      hasEOL: entries.some(({ item }) => item.hasEOL),
      clusterIndex,
      column,
    };
  };

  let lineGroups: VisualLineGroup[] = [];
  clusters.forEach((cluster, clusterIndex) => {
    const ordered = [...cluster].sort((a, b) => a.transform[4] - b.transform[4]);
    const columnGroups: Array<Array<typeof ordered[number]>> = [];
    const gap = Math.max(20, measuredPageWidth * 0.045);
    let previousX: number | undefined;
    let current: Array<typeof ordered[number]> = [];

    for (const entry of ordered) {
      const x = entry.transform[4];
      if (previousX !== undefined && x - previousX > gap) {
        columnGroups.push(current);
        current = [];
      }
      current.push(entry);
      previousX = x;
    }
    if (current.length) columnGroups.push(current);

    columnGroups.forEach((group, columnIndex) => {
      const visualLine = makeVisualLineGroup(
        group,
        clusterIndex,
        // 行内列号仅在页面级双栏无法判定时作为分组线索保留。
        columnGroups.length > 1 ? columnIndex : undefined,
      );
      if (visualLine) lineGroups.push(visualLine);
    });
  });

  const isEdgePageNumberGroup = (group: VisualLineGroup) =>
    group.right > measuredPageWidth * 0.94 &&
    group.entries.length <= 2 &&
    group.entries.every(({ item }) => /^\d+$/.test(item.str.trim()));
  const hintedColumnLayout = (() => {
    const hinted = lineGroups.filter((group) => group.column !== undefined);
    const left = hinted.filter((group) => group.column === 0 && !isEdgePageNumberGroup(group));
    const right = hinted.filter((group) => group.column === 1 && !isEdgePageNumberGroup(group));
    if (left.length < 2 || right.length < 2) return undefined;
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    const leftStart = median(left.map((group) => group.x));
    const rightStart = median(right.map((group) => group.x));
    if (
      rightStart - leftStart < measuredPageWidth * 0.22 ||
      rightStart > measuredPageWidth * 0.92
    ) {
      return undefined;
    }
    return { split: measuredPageWidth / 2 };
  })();
  const columnLayout =
    detectColumnLayout(lineGroups, measuredPageWidth) ?? hintedColumnLayout;
  if (columnLayout) {
    const split = columnLayout.split;
    const refined: VisualLineGroup[] = [];
    for (const group of lineGroups) {
      const leftEntries = group.entries.filter((entry) => entry.transform[4] < split);
      const rightEntries = group.entries.filter((entry) => entry.transform[4] >= split);
      if (
        leftEntries.length &&
        rightEntries.length &&
        group.right - group.x < measuredPageWidth * 0.8
      ) {
        const left = makeVisualLineGroup(leftEntries, group.clusterIndex);
        const right = makeVisualLineGroup(rightEntries, group.clusterIndex);
        if (left) refined.push(left);
        if (right) refined.push(right);
      } else {
        refined.push(group);
      }
    }
    lineGroups = refined;
    for (const group of lineGroups) {
      group.column = group.x < columnLayout.split ? 0 : 1;
    }
  }

  const lines: PdfTextLine[] = lineGroups.map((group, index) => ({
    text: group.text,
    top: group.top,
    x: group.x,
    fontSize: group.fontSize,
    column: group.column,
    hasEOL: group.hasEOL,
    blockId: `p-${group.clusterIndex}-c${group.column ?? index}`,
    itemIndexes: group.entries.map(({ itemIndex }) => itemIndex),
  }));

  // 单栏保持视觉行序；双栏先读完左列再读右列，避免逐行交叉拼接。
  if (columnLayout) {
    return lines.sort(
      (a, b) =>
        (a.column ?? 0) - (b.column ?? 0) ||
        b.top - a.top ||
        (a.x ?? 0) - (b.x ?? 0),
    );
  }
  return lines.sort(
    (a, b) => b.top - a.top || (a.column ?? 0) - (b.column ?? 0) || (a.x ?? 0) - (b.x ?? 0),
  );
}

function detectColumnLayout(
  groups: Array<{ x: number; right: number; entries: unknown[] }>,
  pageWidth: number,
): { split: number } | undefined {
  if (!pageWidth || groups.length < 2) return undefined;

  const candidates = groups.filter((group) => {
    const width = Math.max(1, group.right - group.x);
    const isFullWidth = width > pageWidth * 0.72;
    const isEdgePageNumber =
      group.right > pageWidth * 0.94 &&
      group.entries.length <= 2 &&
      group.entries.every((entry) => {
        const candidate = entry as { item: PdfTextItem };
        return /^\d+$/.test(candidate.item.str.trim());
      });
    return !isFullWidth && !isEdgePageNumber && width >= pageWidth * 0.12;
  });
  if (candidates.length < 6) return undefined;

  const midpoint = pageWidth / 2;
  const left = candidates.filter((group) => group.x <= midpoint);
  const right = candidates.filter((group) => group.x > midpoint);
  const minimumSideCount = Math.max(2, Math.ceil(candidates.length * 0.15));
  if (left.length < minimumSideCount || right.length < minimumSideCount) {
    return undefined;
  }

  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const leftStart = median(left.map((group) => group.x));
  const rightStart = median(right.map((group) => group.x));
  if (rightStart - leftStart < pageWidth * 0.22) return undefined;

  return { split: midpoint };
}

/**
 * 在 PDF.js 的 viewport transform 之上计算透明文本层的 CSS matrix。
 * 这里的 transform 是 PDF.js 中的左上角原点，浏览器 CSS 需要先翻转 y 轴。
 */
export function cssMatrixForTextItem(
  item: PdfTextItem,
  viewportTransform: number[] = [1, 0, 0, -1, 0, 792],
): string {
  const [a, b, c, d, e, f] = normalizeTextItemTransform(item);
  const [v0, v1, v2, v3, v4, v5] = viewportTransform;
  const matrix = [
    v0 * a + v2 * b,
    v1 * a + v3 * b,
    v0 * c + v2 * d,
    v1 * c + v3 * d,
    v0 * e + v2 * f + v4,
    v1 * e + v3 * f + v5,
  ];
  return `matrix(${matrix.map((value) => value.toFixed(4)).join(",")})`;
}

const knownSectionKeys = new Set([
  "abstract",
  "introduction",
  "background",
  "relatedwork",
  "method",
  "methods",
  "methodology",
  "proposedmethod",
  "experiment",
  "experiments",
  "experimentalsetup",
  "experimentalresults",
  "result",
  "results",
  "discussion",
  "conclusion",
  "conclusions",
  "futurework",
  "references",
  "appendix",
  "acknowledgment",
  "acknowledgements",
  "acknowledgments",
  "摘要",
  "引言",
  "方法",
  "结果",
  "结论",
  "参考文献",
  "附录",
]);

const canonicalSectionTitles: Record<string, string> = {
  abstract: "Abstract",
  introduction: "Introduction",
  background: "Background",
  relatedwork: "Related Work",
  method: "Method",
  methods: "Methods",
  methodology: "Methodology",
  proposedmethod: "Proposed Method",
  experiment: "Experiment",
  experiments: "Experiments",
  experimentalsetup: "Experimental Setup",
  experimentalresults: "Experimental Results",
  result: "Result",
  results: "Results",
  discussion: "Discussion",
  conclusion: "Conclusion",
  conclusions: "Conclusions",
  futurework: "Future Work",
  references: "References",
  appendix: "Appendix",
  acknowledgment: "Acknowledgment",
  acknowledgements: "Acknowledgements",
  acknowledgments: "Acknowledgments",
  摘要: "摘要",
  引言: "引言",
  方法: "方法",
  结果: "结果",
  结论: "结论",
  参考文献: "参考文献",
  附录: "附录",
};

function stripSectionNumberPrefix(value: string): string {
  return value
    .replace(
      /^(?:\d+(?:\.\d+)*\.?\s+|(?:[IVXLCDM]{2,8}\.?\s+|[IVXLCDM][.:]\s+|[A-Z][.:]\s+))/i,
      "",
    )
    .trim();
}

function sectionTitleKey(value: string): string {
  return stripSectionNumberPrefix(value)
    .replace(/[^a-z0-9\u4e00-\u9fff]/gi, "")
    .toLowerCase();
}

function isKnownSectionTitle(value: string): boolean {
  const key = sectionTitleKey(value);
  return knownSectionKeys.has(key) || /^appendix[a-z0-9]*$/i.test(key);
}

function isKnownSectionHeading(value: string, fontSize?: number): boolean {
  const normalized = value.trim();
  if (!isKnownSectionTitle(normalized)) return false;
  if ((fontSize ?? 0) >= 13) return true;
  if (/[\u4e00-\u9fff]/.test(normalized)) return true;
  if (/^[A-Z]+(?:\s+[A-Z]+)*$/.test(normalized)) return true;
  return /^[A-Z][a-z]/.test(normalized);
}

function hasSectionWords(value: string): boolean {
  const letters = value.replace(/[^a-z\u4e00-\u9fff]/gi, "").length;
  return letters >= 3 && !/\d\s*$/.test(value.trim());
}

function isPlausibleSectionTitleCore(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 64) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  if (words[0]?.length === 1 && !isKnownSectionTitle(words[0])) return false;
  if (/[=<>≤≥≠≈±×÷→←↑↓∑∏∫∂∇√∞∈∉⊂⊆∪∩∀∃¬∧∨]|["“”]/.test(normalized)) {
    return false;
  }
  return hasSectionWords(normalized);
}

function isNumberedSectionTitle(value: string): boolean {
  const match = value.match(/^(\d{1,2})(?:\.\d{1,2})*\s*[.:]?\s+([A-Za-z\u4e00-\u9fff][^\d].*)$/);
  if (!match) return false;
  const title = match[2].trim();
  return isPlausibleSectionTitleCore(title);
}

function isRomanOrLetterSectionTitle(value: string): boolean {
  const match = value.match(
    /^(?:(?:[IVXLCDM]{1,8})|[A-Z])\s*[.:]\s+([A-Za-z\u4e00-\u9fff][^\d].*)$/i,
  );
  if (!match) return false;
  const title = match[1].trim();
  return isPlausibleSectionTitleCore(title);
}

function isUppercaseHeading(value: string, fontSize?: number): boolean {
  const normalized = value.trim();
  if (!/^[A-Z0-9][A-Z0-9\s&/,'’().:+\-=<>*_-]*$/.test(normalized)) return false;
  const letters = normalized.replace(/[^A-Z]/g, "");
  if (!letters) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  const letterRatio =
    letters.length / Math.max(1, normalized.replace(/\s/g, "").length);
  if (
    letterRatio < 0.6 ||
    /[)\]]$/.test(normalized) ||
    /[=<>≤≥≠≈±×÷→←↑↓∑∏∫∂∇√∞∈∉⊂⊆∪∩∀∃¬∧∨]/.test(normalized)
  ) {
    return false;
  }

  const key = sectionTitleKey(normalized);
  if (
    ["ieee", "issn", "doi", "vol", "no", "page", "figure", "table", "algorithm"].includes(key)
  ) {
    return false;
  }
  if (/^[A-Z](?:\s*[,;&]\s*[A-Z])+$/.test(normalized) && letters.length <= 3) {
    return false;
  }

  const longestWord = Math.max(...(normalized.match(/[A-Z]+/g) ?? [""]).map((word) => word.length));
  if (words.length >= 2 && letters.length >= 4 && longestWord >= 3) return true;
  if (
    letters.length >= 4 &&
    longestWord >= 3 &&
    /[AEIOU]/.test(letters) &&
    !/[-–—]/.test(normalized)
  ) {
    return true;
  }

  // 单字母标题在 PDF 中常因字符间距被拆开；仅在大字号下保留，随后会与相邻碎片合并。
  return (
    (fontSize ?? 0) >= 13 &&
    letters.length <= 8 &&
    !/\d/.test(normalized) &&
    /[AEIOU]/.test(letters)
  );
}

function looksLikeBodySentence(value: string): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (
    words.length >= 5 ||
    /[.?!]\s*$/.test(value)
  );
}

const captionPattern = /^(figure|fig\.?|table)\s*(\d+[a-z]?)\s*[:.]?/i;
const mathChars =
  "\u00b1\u00d7\u00f7\u2264\u2265\u2260\u2248\u221e\u2190\u2192\u2191\u2193\u2211\u220f\u222b\u2202\u2207\u221a\u221d\u2208\u2209\u2282\u2286\u2283\u2287\u222a\u2229\u2200\u2203\u00ac\u2227\u2228\u2295\u2297\u223c\u2243\u2261\u226a\u226b\u22ef\u2026";

function isHeadingLine(text: string, fontSize?: number): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.length > 90) return false;
  if (isKnownSectionHeading(normalized, fontSize)) return true;
  if (isNumberedSectionTitle(normalized)) return true;
  if (isRomanOrLetterSectionTitle(normalized)) return true;
  if (isUppercaseHeading(normalized, fontSize)) return true;
  if ((fontSize ?? 0) >= 16 && normalized.length <= 70 && !looksLikeBodySentence(normalized)) {
    return true;
  }
  return false;
}

function isCaption(text: string): boolean {
  return captionPattern.test(text);
}

function captionLabel(text: string): string | undefined {
  const match = text.match(captionPattern);
  if (!match) return undefined;
  const kind = match[1].toLowerCase().startsWith("fig") ? "Fig." : "Table";
  return `${kind} ${match[2]}`;
}

function mathDensity(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const char of text) {
    if (
      /[\u0370-\u03ff\u1d00-\u1d7f\u2070-\u209f\u2100-\u214f]/.test(char) ||
      mathChars.includes(char)
    ) {
      count += 1;
    }
  }
  return count / text.length;
}

function isEquation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("$$") || trimmed.startsWith("\\[") || trimmed.endsWith("\\]")) return true;
  if (trimmed.length < 260 && mathDensity(trimmed) >= 0.28) return true;
  return false;
}

function splitTableRow(text: string): string[] | undefined {
  if (text.includes("\t")) {
    const cells = text.split("\t").map((cell) => cell.trim()).filter(Boolean);
    return cells.length >= 2 ? cells : undefined;
  }
  if (/\s{2,}/.test(text)) {
    const cells = text.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2 && cells.every((cell) => cell.length <= 46)) return cells;
  }
  if (text.includes("|")) {
    const cells = text.split(/\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 2) return cells;
  }
  return undefined;
}

export function paragraphBlocksFromLines(
  page: number,
  lines: PdfTextLine[],
): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let pending: PdfTextLine[] = [];
  let cursor = 0;

  const addBlock = (
    text: string,
    top: number,
    extra: Partial<ParagraphBlock> = {},
  ) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const start = cursor;
    cursor += normalized.length + 1;
    blocks.push({
      id: `p${page}-b${blocks.length + 1}`,
      page,
      index: blocks.length,
      text: normalized,
      start,
      end: start + normalized.length,
      top,
      ...extra,
    });
  };

  const flush = () => {
    if (!pending.length) return;
    const text = pending.map((line) => line.text.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      const fontSize = Math.max(...pending.map((line) => line.fontSize ?? 0));
      addBlock(text, pending[0]?.top ?? 0, {
        kind: isHeadingLine(text, fontSize) ? "heading" : "paragraph",
        fontSize: fontSize || undefined,
      });
    }
    pending = [];
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    const previousPending = pending.at(-1);
    if (previousPending) {
      const changedColumn =
        previousPending.column !== undefined &&
        line.column !== undefined &&
        previousPending.column !== line.column;
      const explicitBreak = Boolean(previousPending.hasEOL);
      const gap = Math.abs(line.top - previousPending.top);
      const verticalBreak = gap > Math.max(18, (previousPending.fontSize ?? 11) * 1.8);
      const previousFont = previousPending.fontSize;
      const currentFont = line.fontSize;
      const fontDropBreak =
        previousFont !== undefined &&
        currentFont !== undefined &&
        gap > 3 &&
        currentFont <= previousFont * 0.82;
      if (changedColumn || explicitBreak || verticalBreak || fontDropBreak) flush();
    }

    const cells = splitTableRow(text);
    if (
      cells &&
      !isCaption(text) &&
      !isEquation(text) &&
      (text.includes("\t") || !isHeadingLine(text, line.fontSize))
    ) {
      const previousTable = blocks.at(-1);
      if (previousTable?.kind === "table") {
        previousTable.cells?.push(cells);
        previousTable.text += ` ${text.replace(/\s+/g, " ").trim()}`;
        previousTable.end = previousTable.start + previousTable.text.length;
        cursor = previousTable.end + 1;
      } else {
        flush();
        addBlock(text, line.top, { kind: "table", cells: [cells], fontSize: line.fontSize });
      }
      continue;
    }

    if (isCaption(text)) {
      flush();
      addBlock(text, line.top, { kind: "caption", label: captionLabel(text), fontSize: line.fontSize });
      continue;
    }

    if (isEquation(text)) {
      flush();
      addBlock(text, line.top, { kind: "equation", fontSize: line.fontSize });
      continue;
    }

    if (isHeadingLine(text, line.fontSize)) {
      flush();
      addBlock(text, line.top, { kind: "heading", fontSize: line.fontSize });
      continue;
    }

    pending.push(line);
  }
  flush();

  let lastTableCaption: string | undefined;
  for (const block of blocks) {
    if (block.kind === "caption" && block.label?.toLowerCase().startsWith("table")) {
      lastTableCaption = block.label;
    } else if (block.kind === "table" && lastTableCaption) {
      block.label = lastTableCaption;
      lastTableCaption = undefined;
    } else if (block.kind === "caption") {
      lastTableCaption = undefined;
    }
  }
  return blocks;
}

export function buildContext(
  pages: ParsedPage[],
  anchor?: TextAnchor | TextAnchor[],
  surrounding = 2,
) {
  const anchors = Array.isArray(anchor)
    ? anchor.slice(0, MAX_SELECTION_FRAGMENTS)
    : anchor
      ? [anchor]
      : [];
  if (!anchors.length) return "未选择具体原文。请基于论文全文内容回答。";
  if (anchors.length === 1) return buildSingleAnchorContext(pages, anchors[0], surrounding);

  const pagesLabel = [...new Set(anchors.map((item) => item.page))].join("、");
  const sections = [
    `原文定位：第 ${pagesLabel} 页，共 ${anchors.length} 个选中片段`,
  ];
  anchors.forEach((item, index) => {
    const page = pages.find((entry) => entry.page === item.page);
    if (!page) {
      sections.push(`[片段 ${index + 1}] ${item.quote}`);
      return;
    }
    const firstBlock = page.blocks.findIndex((block) => item.blockIds?.includes(block.id));
    const selected = firstBlock < 0 ? 0 : firstBlock;
    const nearby = page.blocks.slice(Math.max(0, selected - surrounding), selected + surrounding + 1);
    sections.push(
      `[片段 ${index + 1}，第 ${item.page} 页${item.section ? `，${item.section}` : ""}] ${item.quote}`,
      ...nearby.map(
        (block) => `[第 ${block.page} 页，段 ${block.index + 1}] ${block.text}`,
      ),
    );
  });
  return sections.join("\n");
}

function buildSingleAnchorContext(
  pages: ParsedPage[],
  anchor: TextAnchor,
  surrounding: number,
) {
  const page = pages.find((item) => item.page === anchor.page);
  if (!page) return `选中原文（第 ${anchor.page} 页）：${anchor.quote}`;
  const firstBlock = page.blocks.findIndex((block) => anchor.blockIds?.includes(block.id));
  const selected = firstBlock < 0 ? 0 : firstBlock;
  const nearby = page.blocks.slice(Math.max(0, selected - surrounding), selected + surrounding + 1);
  return [
    `原文定位：第 ${anchor.page} 页${anchor.section ? `，${anchor.section}` : ""}`,
    `用户选中内容：${anchor.quote}`,
    "相邻上下文：",
    ...nearby.map((block) => `[第 ${block.page} 页，段 ${block.index + 1}] ${block.text}`),
  ].join("\n");
}

export const FULL_PAPER_DIGEST_CHARS = 60000;
const FULL_PAPER_MIN_DIGEST_CHARS = 8000;
const CONTEXT_SECTION_PARAGRAPHS = 3;
const CONTEXT_SPECIAL_SECTION_PARAGRAPHS = 5;
const CONTEXT_PARAGRAPH_CHARS = 600;
const CONTEXT_CAPTION_CHARS = 300;

function isContextPrioritySection(title: string): boolean {
  const normalized = normalizeSectionTitle(title).toLocaleLowerCase();
  return /abstract|conclusion|conclusions|summary/.test(normalized);
}

function sectionHeadingPosition(
  pages: ParsedPage[],
  title: string,
): { pageIndex: number; blockIndex: number } | undefined {
  const normalized = normalizeSectionTitle(title).toLocaleLowerCase();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex += 1) {
      const block = page.blocks[blockIndex];
      if (
        block.kind === "heading" &&
        normalizeSectionTitle(block.text).toLocaleLowerCase() === normalized
      ) {
        return { pageIndex, blockIndex };
      }
    }
  }
  return undefined;
}

function contextSectionLines(
  pages: ParsedPage[],
  section: PaperSection,
  nextSection?: PaperSection,
): string[] {
  const maxParagraphs = isContextPrioritySection(section.title)
    ? CONTEXT_SPECIAL_SECTION_PARAGRAPHS
    : CONTEXT_SECTION_PARAGRAPHS;
  const start = sectionHeadingPosition(pages, section.title);
  const end = nextSection ? sectionHeadingPosition(pages, nextSection.title) : undefined;
  if (!start) return [];
  const lines: string[] = [];
  let paragraphCount = 0;
  for (let pageIndex = start.pageIndex; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    const startBlockIndex = pageIndex === start.pageIndex ? start.blockIndex + 1 : 0;
    const endBlockIndex =
      end && pageIndex === end.pageIndex ? end.blockIndex : page.blocks.length;
    for (let blockIndex = startBlockIndex; blockIndex < endBlockIndex; blockIndex += 1) {
      const block = page.blocks[blockIndex];
      if (block.kind === "heading" || block.kind === "table" || block.kind === "equation") {
        continue;
      }
      if (block.kind === "caption") {
        const caption = block.text.trim();
        if (caption) lines.push(`[p.${block.page}] ${caption.slice(0, CONTEXT_CAPTION_CHARS)}`);
        continue;
      }
      if (paragraphCount >= maxParagraphs) continue;
      const text = block.text.trim();
      if (!text) continue;
      lines.push(`[p.${block.page}] ${text.slice(0, CONTEXT_PARAGRAPH_CHARS)}`);
      paragraphCount += 1;
    }
    if (end && pageIndex >= end.pageIndex) break;
  }
  return lines;
}

function contextFallbackLines(pages: ParsedPage[], perPage = 3): string[] {
  const lines: string[] = [];
  for (const page of pages) {
    let count = 0;
    for (const block of page.blocks) {
      if (count >= perPage) break;
      if (block.kind === "heading" || block.kind === "table" || block.kind === "equation") {
        continue;
      }
      const text = block.text.trim();
      if (!text) continue;
      lines.push(`[p.${block.page}] ${text.slice(0, CONTEXT_PARAGRAPH_CHARS)}`);
      count += 1;
    }
  }
  return lines;
}

export function buildPaperDigest(
  pages: ParsedPage[],
  outline: PaperSection[] = [],
  title = "",
  maxChars = FULL_PAPER_DIGEST_CHARS,
): string {
  if (maxChars <= 0) return "";
  const sections = outline.length ? deduplicateSections(outline) : inferSectionsFromPages(pages);
  const sorted = sections.slice().sort((a, b) => a.page - b.page || a.level - b.level);
  const topLevel = sorted.filter((section) => section.level === 1);
  const grouped = topLevel.length ? topLevel : sorted;
  const outlineLines = sorted.map((section) => {
    const indent = "  ".repeat(Math.max(0, section.level - 1));
    return `${indent}- ${section.title}（p.${section.page}）`;
  });
  const head = [
    title ? `论文标题：${title}` : "",
    outlineLines.length ? "全文结构：" : "",
    ...outlineLines,
  ]
    .filter(Boolean)
    .join("\n");
  let remaining = maxChars - head.length;
  if (remaining < 0) return head.slice(0, maxChars);

  const parts = [head];
  const priority = grouped.filter((section) => isContextPrioritySection(section.title));
  const rest = grouped.filter((section) => !isContextPrioritySection(section.title));
  const ordered = [...priority, ...rest.sort((a, b) => a.page - b.page || a.level - b.level)];
  for (const section of ordered) {
    const groupedIndex = grouped.indexOf(section);
    const nextSection =
      groupedIndex >= 0 && groupedIndex < grouped.length - 1
        ? grouped[groupedIndex + 1]
        : undefined;
    const body = contextSectionLines(pages, section, nextSection).join("\n");
    if (!body) continue;
    const part = `\n\n## ${section.title}（p.${section.page}）\n${body}`;
    if (part.length > remaining) break;
    parts.push(part);
    remaining -= part.length;
  }

  if (parts.length === 1) {
    for (const line of contextFallbackLines(pages)) {
      const part = `\n${line}`;
      if (part.length > remaining) break;
      parts.push(part);
      remaining -= part.length;
    }
  }
  return parts.join("");
}

export function buildFullPaperContext(
  pages: ParsedPage[],
  anchor?: TextAnchor | TextAnchor[],
  outline: PaperSection[] = [],
  title = "",
  maxChars = FULL_PAPER_DIGEST_CHARS,
): string {
  const selectedContext = buildContext(pages, anchor, 2);
  const digestLimit = Math.max(FULL_PAPER_MIN_DIGEST_CHARS, maxChars - selectedContext.length);
  const digest = buildPaperDigest(pages, outline, title, digestLimit);
  if (!digest.trim()) return selectedContext;
  return `${digest}\n\n${selectedContext}`;
}

function normalizeSectionTitle(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*\.+$/, "").trim();
}

export function inferHeadingLevel(text: string, fontSize?: number): number {
  const normalized = normalizeSectionTitle(text);
  const numbered = normalized.match(/^(\d+(?:\.\d+)*)\s+/);
  if (numbered) return Math.min(6, numbered[1].split(".").length);

  // Multi-character Roman prefixes are top-level; single-letter prefixes are
  // usually A-F subsections, while I/V/X/L remain likely Roman headings.
  if (/^(?:[IVXLCDM]{2,8}|[IVXL])\s*[.:]\s+/i.test(normalized)) return 1;
  if (/^[A-Z]\s*[.:]\s+/i.test(normalized)) return 2;

  if (isKnownSectionTitle(normalized)) {
    return 1;
  }
  if ((fontSize ?? 0) >= 16) return 1;
  if ((fontSize ?? 0) >= 13) return 2;
  return 3;
}

export function deduplicateSections(sections: PaperSection[]): PaperSection[] {
  const seen = new Set<string>();
  return sections
    .filter((section) => normalizeSectionTitle(section.title))
    .sort((a, b) => a.page - b.page)
    .filter((section) => {
      const key = [
        section.page,
        section.level,
        normalizeSectionTitle(section.title).toLocaleLowerCase(),
      ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((section, index) => ({
      ...section,
      title: normalizeSectionTitle(section.title),
      id: section.id || `section-${index + 1}`,
    }));
}

interface InferredHeading {
  block: ParagraphBlock;
  title: string;
}

function hasExplicitSectionMarker(title: string): boolean {
  return (
    isKnownSectionTitle(title) ||
    isNumberedSectionTitle(title) ||
    isRomanOrLetterSectionTitle(title)
  );
}

function hasStructuralSectionPrefix(title: string): boolean {
  return isNumberedSectionTitle(title) || isRomanOrLetterSectionTitle(title);
}

function hasTableHeaderNeighbours(page: ParsedPage, block: ParagraphBlock): boolean {
  const neighbours = page.blocks.filter(
    (other) =>
      other.id !== block.id &&
      Math.abs(other.top - block.top) <= 60 &&
      Math.abs(other.index - block.index) <= 8,
  );
  const nearTableCaption = neighbours.some((other) =>
    /^table\s+(?:[ivxlcdm]+|\d+)\b/i.test(other.text.trim()),
  );
  const nearTabularContent = neighbours.some((other) => {
    if (Math.abs(other.top - block.top) > 3) return false;
    const text = other.text.trim();
    const numericValues = text.match(/\d+(?:\.\d+)?/g) ?? [];
    return numericValues.length >= 2 || /\b(?:avg|params|accuracy)\b/i.test(text);
  });
  if (nearTableCaption || nearTabularContent) return true;

  const acronyms = neighbours.filter((other) => {
    const text = other.text.trim();
    const letters = text.replace(/[^A-Z]/g, "");
    return (
      text.length <= 12 &&
      letters.length >= 2 &&
      /^[A-Z0-9-]+$/.test(text) &&
      !/[AEIOU]/.test(letters)
    );
  });
  return acronyms.length >= 2;
}

function isUppercaseHeadingText(value: string): boolean {
  return /^[^a-z]*$/.test(value) && /[A-Z]/.test(value);
}

function isLikelyHeadingFragment(value: string): boolean {
  const letters = value.replace(/[^A-Z]/g, "");
  if (!letters) return false;
  if (/^(?:[IVXLCDM]{1,8}|[A-Z])\s*[.:]$/i.test(value)) return true;
  return letters.length <= 4;
}

function joinHeadingFragments(current: string, next: string): string {
  const concatenated = current + next;
  if (isKnownSectionTitle(concatenated)) return concatenated;
  const tail = current.match(/([A-Za-z0-9]+)[.:]*$/)?.[1] ?? "";
  if (tail.length === 1 && /^[A-Z0-9]+$/.test(next)) return concatenated;
  if (/[-–—]$/.test(current)) return concatenated;
  return `${current} ${next}`;
}

function polishInferredSectionTitle(title: string): string {
  const numberedPrefix = title.match(
    /^((?:\d+(?:\.\d+)*\.?\s+|(?:[IVXLCDM]{2,8}\.?\s+|[IVXLCDM][.:]\s+|[A-Z][.:]\s+)))(.*)$/i,
  );
  if (numberedPrefix?.[2]?.trim()) {
    const prefix = numberedPrefix[1].trim();
    const coreKey = sectionTitleKey(numberedPrefix[2]);
    const core = canonicalSectionTitles[coreKey];
    if (core) return `${prefix} ${core}`;
  }

  const compact = sectionTitleKey(title);
  if (canonicalSectionTitles[compact]) return canonicalSectionTitles[compact];
  return title;
}

function isRejectedInferredHeading(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 100) return true;
  if (
    /[=<>≤≥≠≈±×÷→←↑↓∑∏∫∂∇√∞∈∉⊂⊆∪∩∀∃¬∧∨]|["“”]/.test(normalized) ||
    mathDensity(normalized) >= 0.12
  ) {
    return true;
  }
  const letters = normalized.replace(/[^A-Z]/g, "");
  if (
    /^[^a-z]*$/.test(normalized) &&
    letters.length >= 2 &&
    letters.length <= 8 &&
    !/[AEIOU]/.test(letters)
  ) {
    return true;
  }
  return false;
}

export function inferSectionsFromPages(pages: ParsedPage[]): PaperSection[] {
  const candidates: InferredHeading[] = [];

  for (const page of pages) {
    let firstMajorHeadingFound = false;
    for (const block of page.blocks) {
      if (block.kind !== "heading") continue;
      const title = block.text.replace(/\s+/g, " ").trim();
      if (!title || title.length > 100 || isCaption(title)) continue;
      if (!isHeadingLine(title, block.fontSize)) continue;
      if (isRejectedInferredHeading(title)) continue;
      if (
        isKnownSectionTitle(title) &&
        !hasStructuralSectionPrefix(title) &&
        hasTableHeaderNeighbours(page, block)
      ) {
        continue;
      }

      const explicit = hasExplicitSectionMarker(title);
      const nearTop =
        !page.height || block.top >= page.height * 0.68;
      if (page.page === 1 && !firstMajorHeadingFound && !explicit && nearTop) {
        continue;
      }
      if (explicit) firstMajorHeadingFound = true;
      candidates.push({ block, title });
    }
  }

  const merged: InferredHeading[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    const samePage = previous?.block.page === candidate.block.page;
    const verticalGap = previous
      ? Math.abs(previous.block.top - candidate.block.top)
      : Number.POSITIVE_INFINITY;
    const fontTolerance = Math.max(12, Math.max(
      previous?.block.fontSize ?? 0,
      candidate.block.fontSize ?? 0,
    ) * 1.25);
    const uppercasePair =
      Boolean(previous && isUppercaseHeadingText(previous.title) && isUppercaseHeadingText(candidate.title));
    const compactCurrent = previous?.title.replace(/[^A-Za-z]/g, "") ?? "";
    const compactNext = candidate.title.replace(/[^A-Za-z]/g, "");
    const knownCombination = isKnownSectionTitle(compactCurrent + compactNext);
    const fragmented =
      Boolean(previous && (isLikelyHeadingFragment(previous.title) || isLikelyHeadingFragment(candidate.title))) ||
      (compactCurrent.length <= 6 && compactNext.length <= 6 && compactCurrent.length + compactNext.length <= 14);

    if (samePage && uppercasePair && fragmented && verticalGap <= fontTolerance) {
      previous!.block = {
        ...previous!.block,
        text: joinHeadingFragments(previous!.title, candidate.title),
        top: candidate.block.top,
        fontSize: Math.max(previous!.block.fontSize ?? 0, candidate.block.fontSize ?? 0),
      };
      previous!.title = previous!.block.text;
    } else {
      merged.push({ ...candidate });
    }
  }

  return deduplicateSections(
    merged
      .filter((candidate) => !isRejectedInferredHeading(candidate.title))
      .map((candidate) => {
        const title = polishInferredSectionTitle(candidate.title);
        return {
          id: `inferred-p${candidate.block.page}-b${candidate.block.index}`,
          title,
          page: candidate.block.page,
          level: inferHeadingLevel(title, candidate.block.fontSize),
          source: "inferred",
        };
      }),
  );
}

export async function resolveOutlineDestinationPage(
  destination: unknown[] | null | undefined,
  pageCount: number,
  getPageIndex: (pageReference: PdfPageReference) => Promise<number>,
): Promise<number> {
  if (!Array.isArray(destination) || destination.length === 0 || !destination[0]) return 0;
  try {
    const pageReference = destination[0] as PdfPageReference;
    const pageIndex = await getPageIndex(pageReference);
    return Number.isFinite(pageIndex)
      ? Math.min(pageCount, Math.max(1, pageIndex + 1))
      : 0;
  } catch {
    return 0;
  }
}

export async function flattenPdfOutline(
  outline: PdfOutlineNode[] | null | undefined,
  pageCount: number,
  resolveDestination: (name: string) => Promise<unknown[] | null>,
  getPageIndex: (pageReference: PdfPageReference) => Promise<number>,
): Promise<PaperSection[]> {
  const sections: PaperSection[] = [];

  async function visit(nodes: PdfOutlineNode[] | null | undefined, level: number, inheritedPage: number) {
    if (!nodes?.length) return;
    for (const node of nodes) {
      let targetPage = inheritedPage;
      if (typeof node.dest === "string" && node.dest.trim()) {
        const destination = await resolveDestination(node.dest).catch(() => null);
        if (destination) {
          targetPage = await resolveOutlineDestinationPage(destination, pageCount, getPageIndex);
        }
      } else if (Array.isArray(node.dest)) {
        targetPage = await resolveOutlineDestinationPage(node.dest, pageCount, getPageIndex);
      }

      const title = normalizeSectionTitle(node.title);
      if (title && targetPage > 0) {
        sections.push({
          id: `outline-${sections.length + 1}`,
          title,
          page: targetPage,
          level: Math.max(1, level),
          source: "outline",
        });
      }
      await visit(node.items, level + 1, targetPage || inheritedPage);
    }
  }

  await visit(outline, 1, 0);
  return deduplicateSections(sections);
}

const superscriptMap: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5",
  "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-",
  "⁼": "=", "⁽": "(", "⁾": ")", "ⁿ": "n", "ᵃ": "a", "ᵇ": "b",
  "ᶜ": "c", "ᵈ": "d", "ᵉ": "e", "ᶠ": "f", "ᵍ": "g", "ʰ": "h",
  "ⁱ": "i", "ʲ": "j", "ᵏ": "k", "ˡ": "l", "ᵐ": "m", "ᵖ": "p",
  "ᵗ": "t", "ᵘ": "u", "ᵛ": "v", "ʷ": "w", "ˣ": "x", "ʸ": "y", "ᶻ": "z",
};

const subscriptMap: Record<string, string> = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5",
  "₆": "6", "₇": "7", "₈": "8", "₉": "9", "₊": "+", "₋": "-",
  "₌": "=", "₍": "(", "₎": ")", "ₐ": "a", "ₑ": "e", "ₒ": "o",
  "ₓ": "x", "ₔ": "schwa", "ₕ": "h", "ₖ": "k", "ₗ": "l", "ₘ": "m",
  "ₙ": "n", "ₚ": "p", "ₛ": "s", "ₜ": "t",
};

const greekMap: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi", ρ: "\\rho",
  σ: "\\sigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi", χ: "\\chi",
  ψ: "\\psi", ω: "\\omega",
  Α: "A", Β: "B", Γ: "\\Gamma", Δ: "\\Delta", Ε: "E", Ζ: "Z",
  Η: "H", Θ: "\\Theta", Ι: "I", Κ: "K", Λ: "\\Lambda", Μ: "M",
  Ν: "N", Ξ: "\\Xi", Ο: "O", Π: "\\Pi", Ρ: "P", Σ: "\\Sigma",
  Τ: "T", Υ: "\\Upsilon", Φ: "\\Phi", Χ: "X", Ψ: "\\Psi", Ω: "\\Omega",
};

const symbolMap: Record<string, string> = {
  "±": "\\pm", "×": "\\times", "÷": "\\div", "≤": "\\leq", "≥": "\\geq",
  "≠": "\\neq", "≈": "\\approx", "∞": "\\infty", "→": "\\rightarrow",
  "←": "\\leftarrow", "↑": "\\uparrow", "↓": "\\downarrow",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∂": "\\partial",
  "∇": "\\nabla", "√": "\\sqrt", "∝": "\\propto", "∈": "\\in",
  "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq", "⊃": "\\supset",
  "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∀": "\\forall",
  "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee",
  "⊕": "\\oplus", "⊗": "\\otimes", "∼": "\\sim", "≃": "\\simeq",
  "≡": "\\equiv", "≪": "\\ll", "≫": "\\gg", "·": "\\cdot",
  "∘": "\\circ", "ℓ": "\\ell", "…": "\\ldots", "⋯": "\\cdots",
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}",
  "ℂ": "\\mathbb{C}", "ℚ": "\\mathbb{Q}", "ℍ": "\\mathbb{H}",
};

function convertUnicodeSupSub(value: string): string {
  let output = value;
  for (const [source, target] of Object.entries(superscriptMap)) {
    output = output.split(source).join(`^{${target}}`);
  }
  for (const [source, target] of Object.entries(subscriptMap)) {
    output = output.split(source).join(`_{${target}}`);
  }
  return output;
}

function convertMathSymbols(value: string): string {
  let output = convertUnicodeSupSub(value);
  for (const [source, target] of Object.entries(greekMap)) {
    output = output.split(source).join(target);
  }
  for (const [source, target] of Object.entries(symbolMap)) {
    output = output.split(source).join(target);
  }
  return output;
}

const explicitMathRunPattern =
  /[\u00b2\u00b3\u00b9\u2070-\u209f\u2100-\u214f\u00b1\u00d7\u00f7\u2260-\u22ff\u221e\u2190-\u2193\u2211\u220f\u222b\u2202\u2207\u221a\u221d\u2208\u2209\u2282\u2286\u2283\u2287\u222a\u2229\u2200\u2203\u00ac\u2227\u2228\u2295\u2297\u223c\u2243\u2261\u226a\u226b\u22ef\u2026]|\\[a-zA-Z]+|[_^{}]|(?:\d|[\u0370-\u03ff])[=<>+\-*/]|[=<>+\-*/](?:\d|[\u0370-\u03ff])/;

function hasExplicitMath(value: string): boolean {
  return explicitMathRunPattern.test(value);
}

function convertInlineMath(value: string): string {
  if (!value) return value;
  return value
    .split(/(\s+)/)
    .map((token) => {
      if (!hasExplicitMath(token) || token.startsWith("$")) return token;
      return `$${convertMathSymbols(token)}$`;
    })
    .join("");
}

/**
 * 将 PDF 文本层中常见的 Unicode 数学符号、上下标、希腊字母转换成 LaTeX。
 * 行内模式只处理明确的数学符号串，避免把普通希腊词或缩写误判成公式。
 */
export function latexizeText(value: string, block = false): string {
  const input = value.trim();
  if (!input) return input;
  if (block) {
    const inner = input.replace(/^\$\$?|\$\$?$/g, "").replace(/^\[|\]$/g, "").trim();
    const converted = convertMathSymbols(inner);
    return converted.startsWith("$$") ? converted : `$$${converted}$$`;
  }
  return input
    .split(/(\$\$?[^$]+\$\$?)/g)
    .map((segment) => (segment.startsWith("$") ? segment : convertInlineMath(segment)))
    .join("");
}
