"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  GripVertical,
  Hand,
  LoaderCircle,
  MousePointer2,
  PanelLeftOpen,
  PanelRightOpen,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  clampReaderZoom,
  continuousReaderZoom,
  formatAnchorExcerpt,
  flattenPdfOutline,
  inferSectionsFromPages,
  makeAnchor,
  MAX_READER_ZOOM,
  MIN_READER_ZOOM,
  normalizeReaderWheelDelta,
  normalizeLinkRect,
  paragraphBlocksFromLines,
  sectionHeadingTopRatio,
  stepReaderZoom,
  textLinesFromItems,
} from "@/lib/pdf";
import type { PdfOutlineNode } from "@/lib/pdf";
import type {
  CitationTarget,
  Conversation,
  ChatTurn,
  HighlightColor,
  HighlightRegion,
  Paper,
  PaperSection,
  ParsedPage,
  PdfLinkAnnotation,
  PdfTextItem,
  TextAnchor,
} from "@/lib/types";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfJsDocument = Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>;
type PdfJsPage = Awaited<ReturnType<PdfJsDocument["getPage"]>>;
type MutableNumberRef = { current: number };
type MutableBooleanRef = { current: boolean };

let pdfjsPromise: Promise<PdfJsModule> | undefined;

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return module;
    });
  }
  return pdfjsPromise;
}

type ParsedPdf = Pick<
  Paper,
  "pages" | "pageCount" | "outline" | "originalReady"
> & {
  metadataTitle?: string;
};

function buildTextItems(
  items: Array<{
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
    hasEOL?: boolean;
  } | object>,
): PdfTextItem[] {
  const isTextItem = (item: typeof items[number]): item is {
    str: string;
    transform: number[];
    width?: number;
    height?: number;
    hasEOL?: boolean;
  } => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as {
      str?: unknown;
      transform?: unknown;
    };
    return typeof candidate.str === "string" && Array.isArray(candidate.transform);
  };

  return items
    .filter(isTextItem)
    .map((item) => ({
      str: item.str,
      transform: item.transform.slice(0, 6) as PdfTextItem["transform"],
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      hasEOL: Boolean(item.hasEOL),
    }));
}

interface PdfJsAnnotation {
  subtype?: string;
  rect?: number[];
  dest?: unknown;
  url?: unknown;
}

/**
 * 收集页面上的原生 Link 注解：只保留带内部目标（dest）或外部 URL 的链接，
 * 矩形转换为 scale=1 视口坐标（相对页面左上角，top 向下）。
 */
async function buildPageLinks(
  page: PdfJsPage,
  document: PdfJsDocument,
  viewport: PdfJsViewport,
): Promise<PdfLinkAnnotation[] | undefined> {
  try {
    const annotations = (await page.getAnnotations().catch(() => [])) as PdfJsAnnotation[];
    const links: PdfLinkAnnotation[] = [];
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect) || annotation.rect.length < 4) {
        continue;
      }
      let targetPage: number | undefined;
      let targetTop: number | undefined;
      let url: string | undefined;
      if (typeof annotation.url === "string" && /^https?:\/\//i.test(annotation.url)) {
        url = annotation.url;
      } else if (annotation.dest !== undefined && annotation.dest !== null) {
        const resolved = await resolveAnnotationDest(document, annotation.dest, viewport);
        targetPage = resolved?.page;
        targetTop = resolved?.top;
      }
      if (targetPage === undefined && url === undefined) continue;
      const converted = viewport.convertToViewportRectangle(
        annotation.rect.slice(0, 4) as [number, number, number, number],
      );
      if (!converted || converted.length < 4) continue;
      // convertToViewportRectangle 返回 [x1, y1, x2, y2]，其中 y1/y2 分别是视口
      // 坐标的下边/上边（PDF y 轴向上被翻转），这里统一规范化为 [left, top, right, bottom]。
      links.push({
        rect: normalizeLinkRect(converted),
        targetPage,
        targetTop,
        url,
      });
    }
    return links.length ? links : undefined;
  } catch {
    return undefined;
  }
}

interface ResolvedLinkTarget {
  page: number;
  top?: number;
}

async function resolveAnnotationDest(
  document: PdfJsDocument,
  dest: unknown,
  viewport: PdfJsViewport,
): Promise<ResolvedLinkTarget | undefined> {
  try {
    let destination: unknown[] | null = Array.isArray(dest) ? dest : null;
    if (!destination && typeof dest === "string" && dest.trim()) {
      destination = await document.getDestination(dest).catch(() => null);
    }
    if (!destination || destination.length === 0) return undefined;
    const pageReference = destination[0] as { num: number; gen: number };
    if (!pageReference || typeof pageReference !== "object" || typeof pageReference.num !== "number") {
      return undefined;
    }
    const pageIndex = await document
      .getPageIndex(pageReference as never)
      .catch(() => -1);
    if (!Number.isFinite(pageIndex) || pageIndex < 0) return undefined;

    // 目标坐标：现代格式 [pageRef, {name}, left, top, zoom]；老式格式 [pageRef, x, y, zoom]。
    // PDF 坐标 y 向上、原点在左下角，换算成视口 y（向下、原点左上）。
    let topPdf: number | undefined;
    const second = destination[1];
    if (second && typeof second === "object" && "name" in second) {
      const name = String((second as { name: unknown }).name);
      if (name === "XYZ" || name === "FitH" || name === "FitR") {
        const candidate =
          name === "XYZ" ? destination[3] : name === "FitH" ? destination[2] : destination[4];
        if (typeof candidate === "number") topPdf = candidate;
      }
    } else if (typeof second === "number" && typeof destination[2] === "number") {
      topPdf = destination[2];
    }

    let top: number | undefined;
    if (topPdf !== undefined) {
      const point = viewport.convertToViewportPoint(0, topPdf);
      if (Array.isArray(point) && point.length >= 2 && Number.isFinite(point[1])) {
        top = Math.max(0, point[1]);
      }
    }
    return { page: pageIndex + 1, top };
  } catch {
    return undefined;
  }
}

async function buildParsedPages(file: File): Promise<Omit<ParsedPdf, "originalReady">> {
  const pdfjs = await getPdfJs();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: buffer }).promise;
  const pageCount = document.numPages;
  const pages: ParsedPage[] = [];
  const metadata = await document.getMetadata().catch(() => undefined);
  const metadataInfo = metadata?.info as { Title?: unknown } | undefined;
  const metadataTitle =
    typeof metadataInfo?.Title === "string" && metadataInfo.Title.trim()
      ? metadataInfo.Title.trim()
      : undefined;

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const textItems = buildTextItems(textContent.items);
      const lines = textLinesFromItems(textItems, viewport.width);
      for (const line of lines) {
        for (const itemIndex of line.itemIndexes ?? []) {
          const item = textItems[itemIndex];
          if (item) item.blockId = line.blockId;
        }
      }
      const blocks = paragraphBlocksFromLines(pageNumber, lines);
      const links = await buildPageLinks(page, document, viewport);
      pages.push({
        page: pageNumber,
        text: blocks.map((block) => block.text).join("\n"),
        blocks,
        figures: [],
        links,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
        textItems,
      });
    }
    const outline = await buildOutline(document, pages);
    if (!pages.some((entry) => entry.text.trim())) {
      throw new Error("没有读取到可选择的文本。本版本仅支持带文本层的 PDF，不支持扫描件 OCR。");
    }
    return { pages, pageCount, outline, metadataTitle };
  } finally {
    document.destroy();
  }
}

async function buildOutline(document: PdfJsDocument, pages: ParsedPage[]): Promise<PaperSection[]> {
  const outline = (await document.getOutline().catch(() => null)) as PdfOutlineNode[] | null;
  if (outline?.length) {
    const fromBookmarks = await flattenPdfOutline(
      outline,
      document.numPages,
      async (name) => document.getDestination(name),
      async (reference) => document.getPageIndex(reference),
    ).catch(() => []);
    if (fromBookmarks.length) return fromBookmarks;
  }
  return inferSectionsFromPages(pages);
}

export async function parsePdfFile(file: File): Promise<ParsedPdf> {
  const { pages, pageCount, outline, metadataTitle } = await buildParsedPages(file);
  return {
    pages,
    pageCount,
    outline,
    originalReady: pages.every((page) => Boolean(page.textItems?.length)),
    metadataTitle,
  };
}

export async function repairPaperOriginalMetadata(paper: Paper): Promise<Paper> {
  if (!paper.file) return { ...paper, originalReady: false };
  const file =
    paper.file instanceof File
      ? paper.file
      : new File([paper.file], paper.fileName || "paper.pdf", {
          type: paper.file.type || "application/pdf",
        });
  try {
    const { pages: metadataPages, pageCount, outline } = await buildParsedPages(file);
    const pages = metadataPages.map((metadataPage) => {
      const previous = paper.pages.find((entry) => entry.page === metadataPage.page);
      if (!previous) return metadataPage;
      return {
        ...previous,
        width: metadataPage.width,
        height: metadataPage.height,
        rotation: metadataPage.rotation,
        textItems: metadataPage.textItems,
        links: metadataPage.links,
      };
    });
    return {
      ...paper,
      pages,
      pageCount,
      outline,
      originalReady: pages.every((page) =>
        Boolean(page.textItems?.some((item) => item.str.trim())),
      ),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return { ...paper, originalReady: false };
  }
}

type PdfJsViewport = ReturnType<PdfJsPage["getViewport"]>;
type PdfJsTextContent = Awaited<ReturnType<PdfJsPage["getTextContent"]>>;

export interface ChapterScrollRequest {
  page: number;
  sectionId: string;
  nonce: number;
}

export interface ConversationFocusRequest {
  conversationId: string;
  anchors: TextAnchor[];
  nonce: number;
}

function sectionForPage(sections: PaperSection[], page: number): PaperSection | undefined {
  let active: PaperSection | undefined;
  for (const section of sections) {
    if (section.page > page) break;
    if (section.page === page) {
      return section;
    }
    active = section;
  }
  return active;
}

function sectionStartTop(
  reader: HTMLElement,
  paperData: Paper,
  section: PaperSection,
): number | undefined {
  const pageElement = reader.querySelector<HTMLElement>(`[data-page="${section.page}"]`);
  const stack = pageElement?.querySelector<HTMLElement>(".original-page-stack");
  const pageData = paperData.pages.find((page) => page.page === section.page);
  if (!stack || !pageData) return undefined;
  const ratio = sectionHeadingTopRatio(pageData, section.title);
  if (ratio === undefined) return undefined;
  const stackRect = stack.getBoundingClientRect();
  return stackRect.top + ratio * stackRect.height;
}

function findQuoteStart(page: ParsedPage, quote: string): number {
  const direct = page.text.indexOf(quote);
  if (direct >= 0) return direct;
  for (const block of page.blocks) {
    const within = block.text.indexOf(quote);
    if (within >= 0) return block.start + within;
  }
  const compactQuote = quote.replace(/\s+/g, "");
  if (!compactQuote) return 0;
  for (const block of page.blocks) {
    const within = block.text.replace(/\s+/g, "").indexOf(compactQuote);
    if (within >= 0) return block.start + Math.min(within, Math.max(0, block.text.length - compactQuote.length));
  }
  const withinPage = page.text.replace(/\s+/g, "").indexOf(compactQuote);
  return withinPage >= 0 ? withinPage : 0;
}

const READER_ZOOM_KEY = "papermate-reader-zoom-v1";
const ZOOM_COMMIT_IDLE_MS = 400;
// 单页 canvas 位图像素预算：高缩放时按比例降低有效 DPR，控制栅格化成本与内存。
const MAX_RASTER_PIXELS = 12_000_000;
const RASTER_ZOOM_OVERSCAN = 1.25;
const CLICK_MOVE_THRESHOLD = 5;

interface PendingZoomAnchor {
  page: number;
  shell: HTMLElement;
  stack: HTMLElement;
  clientX: number;
  clientY: number;
  xRatio: number;
  yRatio: number;
}

interface ZoomPageLayout {
  shell: HTMLElement;
  stack: HTMLElement;
  baseWidth: number;
  baseHeight: number;
  renderedZoom: number;
}

interface ZoomSession {
  anchor: PendingZoomAnchor | null;
  pages: ZoomPageLayout[];
  containerWidth: number;
}

interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface SelectionRectLike extends ClientRectLike {
  blockId?: string;
}

interface TextLayerBound {
  span: HTMLElement;
  index: number;
  item: PdfTextItem;
  textNode: Text;
  localOffset: number;
}

interface SelectionTextPoint {
  page: number;
  itemIndex: number;
  offset: number;
  clientX: number;
  clientY: number;
}

interface SelectionItems {
  itemIndexes: number[];
  blockIds: string[];
  quote: string;
  textItemStart: number;
  textItemEnd: number;
  textStartOffset: number;
  textEndOffset: number;
}

type SelectionRectBounds = Pick<
  SelectionItems,
  "itemIndexes" | "textItemStart" | "textItemEnd" | "textStartOffset" | "textEndOffset"
>;

function rectIntersection(
  first: Pick<ClientRectLike, "left" | "right" | "top" | "bottom">,
  second: Pick<ClientRectLike, "left" | "right" | "top" | "bottom">,
): ClientRectLike | undefined {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= left || bottom <= top) return undefined;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function rectDistanceToPoint(
  rect: Pick<ClientRectLike, "left" | "right" | "top" | "bottom">,
  x: number,
  y: number,
) {
  const nearestX = Math.max(rect.left, Math.min(rect.right, x));
  const nearestY = Math.max(rect.top, Math.min(rect.bottom, y));
  return Math.hypot(x - nearestX, y - nearestY);
}

function isElement(node: Node | null | undefined): node is Element {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
}

function isTextNode(node: Node | null | undefined): node is Text {
  return Boolean(node && node.nodeType === Node.TEXT_NODE);
}

function closestTextLayerSpan(node: Node | null | undefined): HTMLElement | undefined {
  if (!node) return undefined;
  if (isElement(node)) {
    if (node.hasAttribute("data-text-item-index")) return node as HTMLElement;
    return node.closest<HTMLElement>("[data-text-item-index]") ?? undefined;
  }
  return node.parentElement?.closest<HTMLElement>("[data-text-item-index]") ?? undefined;
}

function collectTextNodes(root: Node): Text[] {
  if (isTextNode(root)) return [root];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (isTextNode(node)) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function textBoundAtOffset(span: HTMLElement, offset: number, fromEnd = false): {
  textNode: Text;
  localOffset: number;
} {
  const nodes = collectTextNodes(span);
  if (!nodes.length) {
    return {
      textNode: document.createTextNode(""),
      localOffset: 0,
    };
  }
  if (!fromEnd) {
    let remaining = Math.max(0, offset);
    for (const textNode of nodes) {
      if (remaining <= textNode.data.length) {
        return { textNode, localOffset: Math.min(remaining, textNode.data.length) };
      }
      remaining -= textNode.data.length;
    }
  }
  const last = nodes.at(-1)!;
  let remaining = Math.max(0, offset);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const textNode = nodes[index];
    if (remaining <= textNode.data.length) {
      return {
        textNode,
        localOffset: Math.min(textNode.data.length, textNode.data.length - remaining),
      };
    }
    remaining -= textNode.data.length;
  }
  return { textNode: last, localOffset: last.data.length };
}

function textLayerSpans(stack: HTMLElement): HTMLElement[] {
  return Array.from(stack.querySelectorAll<HTMLElement>("[data-text-item-index]")).sort((a, b) => {
    const aIndex = Number(a.dataset.textItemIndex ?? -1);
    const bIndex = Number(b.dataset.textItemIndex ?? -1);
    return aIndex - bIndex;
  });
}

function stackForPoint(clientX: number, clientY: number): HTMLElement | undefined {
  const stack = document
    .elementsFromPoint(clientX, clientY)
    .map((element) => (element instanceof Element ? element.closest<HTMLElement>(".original-page-stack") : null))
    .find((element): element is HTMLElement => Boolean(element));
  return stack ?? undefined;
}

function spanCandidatesAtPoint(
  stack: HTMLElement,
  clientX: number,
  clientY: number,
): HTMLElement[] {
  const underPointer = document
    .elementsFromPoint(clientX, clientY)
    .filter((element) => {
      if (!(element instanceof Element)) return false;
      return element.hasAttribute("data-text-item-index") && stack.contains(element);
    }) as HTMLElement[];
  const nearby = textLayerSpans(stack).filter((span) => {
    const rect = span.getBoundingClientRect();
    return rectDistanceToPoint(rect, clientX, clientY) <= 22;
  });
  return [...new Set([...underPointer, ...nearby])];
}

function chooseSpanAtPoint(
  stack: HTMLElement,
  start: SelectionTextPoint | undefined,
  clientX: number,
  clientY: number,
): HTMLElement | undefined {
  const caret = document.caretRangeFromPoint(clientX, clientY);
  const caretSpan = closestTextLayerSpan(caret?.startContainer);
  if (caretSpan && stack.contains(caretSpan)) {
    const caretRect = caretSpan.getBoundingClientRect();
    if (caretRect.width >= 0.5 && caretRect.height >= 0.5) {
      return caretSpan;
    }
  }

  const startSpan =
    start && start.page === Number(stack.parentElement?.getAttribute("data-page"))
      ? stack.querySelector<HTMLElement>(`[data-text-item-index="${start.itemIndex}"]`)
      : undefined;
  const startRect = startSpan?.getBoundingClientRect();
  let best: HTMLElement | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const span of spanCandidatesAtPoint(stack, clientX, clientY)) {
    const rect = span.getBoundingClientRect();
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    const horizontalOverlap = startRect
      ? Math.max(
          0,
          Math.min(startRect.right, rect.right) -
            Math.max(startRect.left, rect.left),
        )
      : 0;
    const horizontalOverlapRatio =
      startRect && startRect.width > 0
        ? horizontalOverlap / Math.max(1, Math.min(startRect.width, rect.width))
        : 0;
    const sameColumnWeight =
      horizontalOverlapRatio >= 0.45 ? horizontalOverlapRatio * 4 : 0;
    const score =
      rectDistanceToPoint(rect, clientX, clientY) -
      sameColumnWeight;
    if (score < bestScore) {
      bestScore = score;
      best = span;
    }
  }

  return best;
}

function rangeAtOffset(span: HTMLElement, offset: number): Range {
  const first = collectTextNodes(span)[0];
  const boundary = textBoundAtOffset(span, Math.max(0, Math.min(offset, collectTextNodes(span).reduce((sum, node) => sum + node.data.length, 0))));
  const range = document.createRange();
  if (first) {
    range.setStart(first, 0);
    range.setEnd(boundary.textNode, boundary.localOffset);
  } else {
    range.setStart(boundary.textNode, 0);
    range.setEnd(boundary.textNode, 0);
  }
  return range;
}

function rangeForItemOffsets(
  span: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range | undefined {
  const length = collectTextNodes(span).reduce((sum, node) => sum + node.data.length, 0);
  const start = Math.min(length, Math.max(0, startOffset));
  const end = Math.min(length, Math.max(start, endOffset));
  const startBound = textBoundAtOffset(span, start);
  const endBound = textBoundAtOffset(span, end);
  const range = document.createRange();
  range.setStart(startBound.textNode, startBound.localOffset);
  range.setEnd(endBound.textNode, endBound.localOffset);
  return range;
}

function offsetAtClientX(
  span: HTMLElement,
  clientX: number,
  clientY: number,
): number {
  const textNodes = collectTextNodes(span);
  const length = textNodes.reduce((sum, node) => sum + node.data.length, 0);
  if (!length) return 0;
  const caret = document.caretRangeFromPoint(clientX, clientY);
  const caretSpan = closestTextLayerSpan(caret?.startContainer);
  if (caret && caretSpan === span && caret.startContainer.nodeType === Node.TEXT_NODE) {
    let offset = 0;
    for (const textNode of textNodes) {
      if (textNode === caret.startContainer) {
        return Math.min(length, offset + Math.min(textNode.data.length, caret.startOffset));
      }
      offset += textNode.data.length;
    }
  }

  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const rangeRect = rangeAtOffset(span, middle).getBoundingClientRect();
    if (rangeRect.right <= clientX) low = middle;
    else high = middle - 1;
  }
  return low;
}

function selectionPointAtPosition(
  stack: HTMLElement | undefined,
  start: SelectionTextPoint | undefined,
  clientX: number,
  clientY: number,
): SelectionTextPoint | undefined {
  if (!stack) return undefined;
  const pageElement = stack.parentElement;
  const page = Number(pageElement?.getAttribute("data-page"));
  if (!Number.isInteger(page)) return undefined;
  const span = chooseSpanAtPoint(stack, start, clientX, clientY);
  if (!span) return undefined;
  const itemIndex = Number(span.dataset.textItemIndex);
  if (!Number.isInteger(itemIndex) || itemIndex < 0) return undefined;
  return {
    page,
    itemIndex,
    offset: offsetAtClientX(span, clientX, clientY),
    clientX,
    clientY,
  };
}

function selectionItemsBetweenPoints(
  page: ParsedPage,
  stack: HTMLElement,
  start: SelectionTextPoint,
  end: SelectionTextPoint,
): SelectionItems | undefined {
  const items = page.textItems ?? [];
  if (!items.length) return undefined;
  const lowIndex = Math.min(start.itemIndex, end.itemIndex);
  const highIndex = Math.max(start.itemIndex, end.itemIndex);
  const lowPoint = start.itemIndex <= end.itemIndex ? start : end;
  const highPoint = start.itemIndex <= end.itemIndex ? end : start;
  const lowOffset = Math.min(Math.max(0, lowPoint.offset), items[lowIndex]?.str.length ?? 0);
  const highOffset = Math.min(Math.max(0, highPoint.offset), items[highIndex]?.str.length ?? 0);

  const lowSpan = stack.querySelector<HTMLElement>(`[data-text-item-index="${lowIndex}"]`);
  const highSpan = stack.querySelector<HTMLElement>(`[data-text-item-index="${highIndex}"]`);
  const lowRect = lowSpan?.getBoundingClientRect();
  const highRect = highSpan?.getBoundingClientRect();
  const minY = Math.min(start.clientY, end.clientY) - 2;
  const maxY = Math.max(start.clientY, end.clientY) + 2;

  let columnLeft = Math.min(lowRect?.left ?? 0, highRect?.left ?? 0) - 6;
  let columnRight = Math.max(lowRect?.right ?? 0, highRect?.right ?? 0) + 6;
  if (lowRect && highRect) {
    const overlap = rectIntersection(lowRect, highRect);
    const sameColumn =
      overlap &&
      overlap.width >
        Math.min(lowRect.width, highRect.width) * 0.35;
    if (sameColumn) {
      columnLeft = Math.max(lowRect.left, highRect.left) - 4;
      columnRight = Math.min(lowRect.right, highRect.right) + 4;
    }
  }

  const itemIndexes: number[] = [];
  for (let index = lowIndex; index <= highIndex; index += 1) {
    const item = items[index];
    const span = stack.querySelector<HTMLElement>(`[data-text-item-index="${index}"]`);
    const rect = span?.getBoundingClientRect();
    if (!item || !rect || rect.width < 0.5 || rect.height < 0.5) continue;
    const centerY = (rect.top + rect.bottom) / 2;
    const centerX = (rect.left + rect.right) / 2;
    const inside =
      index === lowIndex ||
      index === highIndex ||
      (centerY >= minY &&
        centerY <= maxY &&
        centerX >= columnLeft &&
        centerX <= columnRight);
    if (inside) itemIndexes.push(index);
  }
  if (!itemIndexes.length) return undefined;

  const quoteParts: string[] = [];
  const blockIds: string[] = [];
  for (let position = 0; position < itemIndexes.length; position += 1) {
    const index = itemIndexes[position];
    const item = items[index];
    let value = item.str;
    if (index === lowIndex) value = value.slice(lowOffset);
    if (index === highIndex) value = value.slice(0, highOffset);
    if (lowIndex === highIndex) value = item.str.slice(lowOffset, highOffset);
    quoteParts.push(value);
    if (item.hasEOL && position < itemIndexes.length - 1) quoteParts.push("\n");
    if (item.blockId) blockIds.push(item.blockId);
  }
  const quote = quoteParts
    .join("")
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
  if (!quote) return undefined;

  return {
    itemIndexes,
    blockIds: [...new Set(blockIds)],
    quote,
    textItemStart: lowIndex,
    textItemEnd: highIndex,
    textStartOffset: lowOffset,
    textEndOffset: highOffset,
  };
}

function allowedSpansForItems(
  stack: HTMLElement,
  itemIndexes: number[],
): HTMLElement[] {
  const allowed = new Set(itemIndexes);
  return textLayerSpans(stack).filter((span) => {
    const index = Number(span.dataset.textItemIndex);
    return allowed.has(index);
  });
}

function spanBoundsForTextLayer(textLayer: InstanceType<PdfJsModule["TextLayer"]>, page: ParsedPage) {
  const items = page.textItems ?? [];
  textLayer.textDivs.forEach((span, index) => {
    const item = items[index];
    if (!item) return;
    span.dataset.textItemIndex = String(index);
    if (item.blockId) span.dataset.blockId = item.blockId;
  });
}

function exactTextBound(
  stack: HTMLElement,
  page: ParsedPage,
  itemIndex: number,
  offset: number,
  fromEnd = false,
): TextLayerBound | undefined {
  const items = page.textItems ?? [];
  const item = items[itemIndex];
  const span = stack.querySelector<HTMLElement>(`[data-text-item-index="${itemIndex}"]`);
  if (!item || !span) return undefined;
  const boundary = textBoundAtOffset(span, offset, fromEnd);
  return {
    span,
    index: itemIndex,
    item,
    textNode: boundary.textNode,
    localOffset: boundary.localOffset,
  };
}

function quoteBoundsInSpans(
  stack: HTMLElement,
  page: ParsedPage,
  quote: string,
): { start: TextLayerBound; end: TextLayerBound } | undefined {
  const compact = quote.replace(/\s+/g, "");
  if (!compact) return undefined;
  const bounds: TextLayerBound[] = [];
  let compactText = "";
  const maps: Array<{ itemIndex: number; offset: number }> = [];
  for (const span of textLayerSpans(stack)) {
    const itemIndex = Number(span.dataset.textItemIndex);
    const item = page.textItems?.[itemIndex];
    if (!item || !Number.isInteger(itemIndex)) continue;
    for (let offset = 0; offset < item.str.length; offset += 1) {
      if (!/\s/.test(item.str[offset])) {
        compactText += item.str[offset];
        maps.push({ itemIndex, offset });
      }
    }
  }
  const found = compactText.indexOf(compact);
  if (found < 0) return undefined;
  const startMap = maps[found];
  const endMap = maps[found + compact.length - 1];
  if (!startMap || !endMap) return undefined;
  const startBound = exactTextBound(stack, page, startMap.itemIndex, startMap.offset);
  const endBound = exactTextBound(stack, page, endMap.itemIndex, endMap.offset + 1);
  if (!startBound || !endBound) return undefined;
  return { start: startBound, end: endBound };
}

function rangeForAnchor(
  stack: HTMLElement,
  page: ParsedPage,
  anchor: TextAnchor,
): Range | undefined {
  const items = page.textItems ?? [];
  const hasExactBounds =
    Number.isInteger(anchor.textItemStart) &&
    Number.isInteger(anchor.textItemEnd) &&
    Number.isInteger(anchor.textStartOffset) &&
    Number.isInteger(anchor.textEndOffset) &&
    Boolean(items[anchor.textItemStart ?? -1]) &&
    Boolean(items[anchor.textItemEnd ?? -1]);
  const bounds = hasExactBounds
    ? {
        start: exactTextBound(
          stack,
          page,
          Math.min(items.length - 1, Math.max(0, anchor.textItemStart ?? 0)),
          anchor.textStartOffset ?? 0,
        ),
        end: exactTextBound(
          stack,
          page,
          Math.min(items.length - 1, Math.max(0, anchor.textItemEnd ?? 0)),
          anchor.textEndOffset ?? 0,
        ),
      }
    : quoteBoundsInSpans(stack, page, anchor.quote);
  if (!bounds?.start || !bounds?.end) return undefined;
  const range = document.createRange();
  range.setStart(
    bounds.start.textNode,
    Math.min(
      bounds.start.textNode.data.length,
      Math.max(0, bounds.start.localOffset),
    ),
  );
  range.setEnd(
    bounds.end.textNode,
    Math.min(
      bounds.end.textNode.data.length,
      Math.max(0, bounds.end.localOffset),
    ),
  );
  return range;
}

function normalizedClientRects(
  range: Range,
  stack: HTMLElement,
  allowedSpans?: HTMLElement[],
  selectionBounds?: SelectionRectBounds,
): ClientRectLike[] {
  const stackRect = stack.getBoundingClientRect();
  if (!stackRect.width || !stackRect.height) return [];
  if (allowedSpans?.length && selectionBounds) {
    return selectionRectsFromTextSpans(stack, stackRect, allowedSpans, selectionBounds);
  }

  const rects: ClientRectLike[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    const left = Math.max(stackRect.left, rect.left);
    const top = Math.max(stackRect.top, rect.top);
    const right = Math.min(stackRect.right, rect.right);
    const bottom = Math.min(stackRect.bottom, rect.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 0.5 || height < 0.5) continue;
    if (width > stackRect.width * 1.02 || height > stackRect.height * 1.02) continue;
    rects.push({ left, top, width, height, right, bottom });
  }
  return mergeAndSeparateLineRects(rects);
}

function selectionRectsFromTextSpans(
  stack: HTMLElement,
  stackRect: DOMRect,
  spans: HTMLElement[],
  bounds: SelectionRectBounds,
): ClientRectLike[] {
  const selectedItems = new Set(bounds.itemIndexes);
  const entries = spans
    .map((span, position) => ({
      span,
      position,
      itemIndex: Number(span.dataset.textItemIndex),
      blockId: span.dataset.blockId,
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.itemIndex) && selectedItems.has(entry.itemIndex),
    )
    .sort((a, b) => a.itemIndex - b.itemIndex || a.position - b.position);

  const rects: SelectionRectLike[] = [];
  for (const entry of entries) {
    const itemLength = collectTextNodes(entry.span).reduce(
      (sum, node) => sum + node.data.length,
      0,
    );
    const startOffset =
      entry.itemIndex === bounds.textItemStart
        ? Math.min(itemLength, Math.max(0, bounds.textStartOffset))
        : 0;
    const endOffset =
      entry.itemIndex === bounds.textItemEnd
        ? Math.min(itemLength, Math.max(0, bounds.textEndOffset))
        : itemLength;
    const itemRange = rangeForItemOffsets(entry.span, startOffset, endOffset);
    if (!itemRange) continue;
    const spanRect = entry.span.getBoundingClientRect();
    if (spanRect.width < 0.5 || spanRect.height < 0.5) continue;

    for (const rangeRect of Array.from(itemRange.getClientRects())) {
      if (rangeRect.width < 0.5 || rangeRect.height < 0.5) continue;
      if (
        rangeRect.width > Math.max(stackRect.width, spanRect.width) * 1.05 ||
        rangeRect.height > stackRect.height * 1.05
      ) {
        continue;
      }
      const left = Math.max(stackRect.left, spanRect.left, rangeRect.left);
      const right = Math.min(stackRect.right, spanRect.right, rangeRect.right);
      const width = right - left;
      if (width < 0.5) continue;
      const top = Math.max(stackRect.top, spanRect.top);
      const bottom = Math.min(stackRect.bottom, spanRect.bottom);
      const height = bottom - top;
      if (height < 0.5) continue;

      rects.push({
        left,
        top,
        right,
        bottom,
        width,
        height,
        blockId: entry.blockId,
      });
    }
  }
  return mergeSameRowRects(rects);
}

function mergeSameRowRects(rects: SelectionRectLike[]): SelectionRectLike[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: SelectionRectLike[] = [];
  for (const rect of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      (previous.blockId ?? "") === (rect.blockId ?? "") &&
      Math.abs(previous.top - rect.top) <= 1.25 &&
      rect.left <= previous.right + 2.5
    ) {
      previous.left = Math.min(previous.left, rect.left);
      previous.right = Math.max(previous.right, rect.right);
      previous.top = Math.min(previous.top, rect.top);
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      previous.width = previous.right - previous.left;
      previous.height = previous.bottom - previous.top;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function mergeAndSeparateLineRects(rects: ClientRectLike[]): ClientRectLike[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: ClientRectLike[] = [];
  for (const rect of sorted) {
    const previous = merged.at(-1);
    const previousCenter = previous
      ? (previous.top + previous.bottom) / 2
      : 0;
    const rectCenter = (rect.top + rect.bottom) / 2;
    const verticalOverlap =
      previous && previousCenter
        ? Math.min(previous.bottom, rect.bottom) -
          Math.max(previous.top, rect.top)
        : 0;
    const sameLine =
      previous &&
      verticalOverlap >
        Math.min(previous.height, rect.height) * 0.72 &&
      Math.abs(previousCenter - rectCenter) < 4 &&
      previous.right >= rect.left - 2.5;
    if (sameLine) {
      previous.left = Math.min(previous.left, rect.left);
      previous.right = Math.max(previous.right, rect.right);
      previous.top = Math.min(previous.top, rect.top);
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      previous.width = previous.right - previous.left;
      previous.height = previous.bottom - previous.top;
    } else {
      merged.push({ ...rect });
    }
  }

  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const current = merged[index];
    const horizontalOverlap =
      Math.min(previous.right, current.right) - Math.max(previous.left, current.left);
    const verticalOverlap =
      Math.min(previous.bottom, current.bottom) - Math.max(previous.top, current.top);
    const sharedWidth = Math.min(previous.width, current.width);
    if (horizontalOverlap <= 1 || verticalOverlap <= 1 || horizontalOverlap < sharedWidth * 0.12) {
      continue;
    }
    const boundary =
      ((previous.top + previous.bottom) / 2 + (current.top + current.bottom) / 2) / 2;
    const previousBottom = Math.min(previous.bottom, boundary);
    const currentTop = Math.max(current.top, boundary);
    if (previousBottom > previous.top) {
      previous.bottom = previousBottom;
      previous.height = previous.bottom - previous.top;
    }
    if (currentTop < current.bottom) {
      current.top = currentTop;
      current.height = current.bottom - current.top;
    }
  }
  return merged;
}

function renderHighlightRects(
  layer: HTMLElement | null | undefined,
  stack: HTMLElement | null | undefined,
  rects: ClientRectLike[],
) {
  if (!layer || !stack) return;
  layer.replaceChildren();
  appendHighlightRects(layer, rects);
}

function appendHighlightRects(
  layer: HTMLElement,
  rects: ClientRectLike[],
  anchorId?: string,
  region?: HighlightRegion,
  fallbackColor?: HighlightColor,
) {
  const layerRect = layer.getBoundingClientRect();
  const scaleX = layerRect.width && layer.offsetWidth
    ? layerRect.width / layer.offsetWidth
    : 1;
  const scaleY = layerRect.height && layer.offsetHeight
    ? layerRect.height / layer.offsetHeight
    : 1;
  for (const rect of rects) {
    const piece = document.createElement("div");
    piece.className = "original-selection-highlight-piece";
    if (anchorId) piece.dataset.anchorId = anchorId;
    if (region) {
      piece.dataset.regionId = region.id;
      piece.dataset.conversationIds = JSON.stringify(region.conversationIds);
      piece.dataset.highlightColor = region.color;
      piece.style.setProperty("--hl-color", region.color);
    } else if (fallbackColor) {
      // 尚未提问的划选选区：用待用颜色着色，切换颜色即时生效。
      piece.dataset.highlightColor = fallbackColor;
      piece.style.setProperty("--hl-color", fallbackColor);
    }
    piece.style.left = `${(rect.left - layerRect.left) / scaleX}px`;
    piece.style.top = `${(rect.top - layerRect.top) / scaleY}px`;
    piece.style.width = `${rect.width / scaleX}px`;
    piece.style.height = `${rect.height / scaleY}px`;
    layer.append(piece);
  }
}

function renderPersistentHighlights(
  stack: HTMLElement,
  layer: HTMLElement,
  page: ParsedPage,
  anchors: TextAnchor[],
  regions: HighlightRegion[],
  pendingColor?: HighlightColor,
) {
  layer.replaceChildren();
  const renderedRegionIds = new Set<string>();
  for (const region of regions) {
    if (region.anchor.page !== page.page || renderedRegionIds.has(region.id)) continue;
    renderedRegionIds.add(region.id);
    const range = rangeForAnchor(stack, page, region.anchor);
    if (!range) continue;
    const itemIndexes = Number.isInteger(region.anchor.textItemStart) && Number.isInteger(region.anchor.textItemEnd)
      ? Array.from(
          { length: Math.max(0, (region.anchor.textItemEnd ?? region.anchor.textItemStart ?? 0) - (region.anchor.textItemStart ?? 0) + 1) },
          (_, index) => (region.anchor.textItemStart ?? 0) + index,
        )
      : [];
    const hasExactBounds =
      itemIndexes.length > 0 &&
      Number.isInteger(region.anchor.textStartOffset) &&
      Number.isInteger(region.anchor.textEndOffset);
    const selectionBounds: SelectionRectBounds | undefined = hasExactBounds
      ? {
          itemIndexes,
          textItemStart: region.anchor.textItemStart ?? 0,
          textItemEnd: region.anchor.textItemEnd ?? 0,
          textStartOffset: region.anchor.textStartOffset ?? 0,
          textEndOffset: region.anchor.textEndOffset ?? 0,
        }
      : undefined;
    const allowedSpans = itemIndexes.length
      ? textLayerSpans(stack).filter((span) => {
          const itemIndex = Number(span.dataset.textItemIndex);
          if (!region.anchor.blockIds?.length) return itemIndexes.includes(itemIndex);
          return (
            itemIndexes.includes(itemIndex) &&
            region.anchor.blockIds.includes(span.dataset.blockId ?? "")
          );
        })
      : undefined;
    appendHighlightRects(
      layer,
      normalizedClientRects(range, stack, allowedSpans, selectionBounds),
      region.anchor.id,
      region,
    );
  }
  for (const anchor of anchors) {
    if (anchor.page !== page.page) continue;
    if (renderedRegionIds.has(`region:${anchor.id}`)) continue;
    const range = rangeForAnchor(stack, page, anchor);
    if (!range) continue;
    const itemIndexes = Number.isInteger(anchor.textItemStart) && Number.isInteger(anchor.textItemEnd)
      ? Array.from(
          { length: Math.max(0, (anchor.textItemEnd ?? anchor.textItemStart ?? 0) - (anchor.textItemStart ?? 0) + 1) },
          (_, index) => (anchor.textItemStart ?? 0) + index,
        )
      : [];
    const hasExactBounds =
      itemIndexes.length > 0 &&
      Number.isInteger(anchor.textStartOffset) &&
      Number.isInteger(anchor.textEndOffset);
    const selectionBounds: SelectionRectBounds | undefined = hasExactBounds
      ? {
          itemIndexes,
          textItemStart: anchor.textItemStart ?? 0,
          textItemEnd: anchor.textItemEnd ?? 0,
          textStartOffset: anchor.textStartOffset ?? 0,
          textEndOffset: anchor.textEndOffset ?? 0,
        }
      : undefined;
    const allowedSpans = itemIndexes.length
      ? textLayerSpans(stack).filter((span) => {
          const itemIndex = Number(span.dataset.textItemIndex);
          if (!anchor.blockIds?.length) return itemIndexes.includes(itemIndex);
          return (
            itemIndexes.includes(itemIndex) &&
            anchor.blockIds.includes(span.dataset.blockId ?? "")
          );
        })
      : undefined;
    appendHighlightRects(
      layer,
      normalizedClientRects(range, stack, allowedSpans, selectionBounds),
      anchor.id,
      undefined,
      pendingColor,
    );
  }
}

function clearCurrentSelectionHighlights(root: HTMLElement | null | undefined) {
  root
    ?.querySelectorAll<HTMLElement>('[data-highlight-role="current"]')
    .forEach((layer) => layer.replaceChildren());
}

/**
 * 渲染 PDF 原生 Link 注解层：每个链接按注解矩形定位（相对页面左上角，
 * scale=1 视口坐标），点击后跳转目标页或打开外部 URL。
 * 不做文本匹配：原 PDF 没有链接的区域不显示跳转。
 */
function renderPageLinks(
  layer: HTMLElement | null | undefined,
  stack: HTMLElement | null | undefined,
  links: PdfLinkAnnotation[] | undefined,
  savedPage: ParsedPage,
  onJump: (target: CitationTarget) => void,
  onOpenUrl: (url: string) => void,
) {
  if (!layer || !stack || !links?.length) return;
  layer.replaceChildren();
  const pageWidth = savedPage.width || 0;
  const pageHeight = savedPage.height || 0;
  if (!pageWidth || !pageHeight) return;
  const scaleX = stack.offsetWidth && pageWidth ? stack.offsetWidth / pageWidth : 1;
  const scaleY = stack.offsetHeight && pageHeight ? stack.offsetHeight / pageHeight : 1;

  for (const link of links) {
    // 存量数据可能存了 y 顺序颠倒的矩形（PDF y 轴翻转导致），渲染前统一规范化。
    const [left, top, right, bottom] = normalizeLinkRect(link.rect);
    if (right <= left || bottom <= top) continue;
    const piece = document.createElement("button");
    piece.type = "button";
    piece.className = "original-citation-link";
    piece.title = link.url ? link.url : `跳转到第 ${link.targetPage} 页`;
    piece.style.left = `${Math.round(left * scaleX)}px`;
    piece.style.top = `${Math.round(top * scaleY)}px`;
    piece.style.width = `${Math.max(2, Math.round((right - left) * scaleX))}px`;
    piece.style.height = `${Math.max(2, Math.round((bottom - top) * scaleY))}px`;
    piece.addEventListener("pointerdown", (event) => event.stopPropagation());
    piece.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (link.url) onOpenUrl(link.url);
      else if (link.targetPage) onJump({ page: link.targetPage, top: link.targetTop ?? 0 });
    });
    layer.append(piece);
  }
}

function renderCurrentSelectionBetweenPoints(
  root: HTMLElement | null | undefined,
  page: ParsedPage | undefined,
  start: SelectionTextPoint | undefined,
  end: SelectionTextPoint | undefined,
) {
  if (!root || !page || !start || !end || start.page !== end.page) {
    clearCurrentSelectionHighlights(root);
    return;
  }
  clearCurrentSelectionHighlights(root);
  const stack = root.querySelector<HTMLElement>(`[data-page="${start.page}"] .original-page-stack`);
  const layer = root.querySelector<HTMLElement>(
    `[data-page="${start.page}"] [data-highlight-role="current"]`,
  );
  if (!stack || !layer) return;
  const selected = selectionItemsBetweenPoints(page, stack, start, end);
  if (!selected) return;
  const range = rangeForAnchor(
    stack,
    page,
    makeAnchor("", page, selected.quote, 0, undefined, {
      blockIds: selected.blockIds,
      textItemStart: selected.textItemStart,
      textItemEnd: selected.textItemEnd,
      textStartOffset: selected.textStartOffset,
      textEndOffset: selected.textEndOffset,
    }),
  );
  if (!range) return;
  appendHighlightRects(
    layer,
    normalizedClientRects(
      range,
      stack,
      allowedSpansForItems(stack, selected.itemIndexes),
      selected,
    ),
  );
}

function useReaderWidth(
  readerRef: RefObject<HTMLElement | null>,
  scalingRef?: MutableBooleanRef,
  refreshKey?: number,
) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = readerRef.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (scalingRef?.current) return;
      const style = window.getComputedStyle(element);
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      setWidth(Math.max(260, element.clientWidth - horizontalPadding));
    };
    const schedule = () => {
      // 拖动侧边栏期间冻结阅读器宽度：页面保持原尺寸与位置，避免内容随拖拽
      // 逐帧重排造成滚动跳动；拖动结束（papermate-resize-settled）后立即重测。
      if (document.body.classList.contains("papermate-resizing")) return;
      // rAF 合并：一帧内多次尺寸变化只提交一次，避免逐帧触发 React 渲染。
      if (scalingRef?.current) return;
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    const onSettled = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      if (!document.body.classList.contains("papermate-resizing")) measure();
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("papermate-resize-settled", onSettled);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("papermate-resize-settled", onSettled);
    };
  }, [readerRef, refreshKey, scalingRef]);

  return width;
}

function applyStackLiveZoom(
  shell: HTMLElement | null,
  stack: HTMLElement,
  factor: number,
  baseLayoutHeight?: number,
  baseLayoutWidth?: number,
  containerWidth?: number,
) {
  // 实时缩放只作用于 .original-page-stack（页面本体），上方的 P.XX 页码标签保持恒定大小。
  // 提交后 .original-page 的真实宽度是 min(目标页宽, 容器宽)，并由 auto margin 居中；
  // 实时阶段必须同步这个 shell 宽度，否则横向滚动范围仍按旧页宽计算，提交瞬间页面会
  // 重新居中，光标下的内容随之漂移。transform-origin 再根据 stack 在 shell 内的真实
  // auto margin 位置计算，使缩放中的视觉页框与提交后的布局完全一致。
  if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
    const layoutWidth = baseLayoutWidth ?? (stack.offsetWidth || 1);
    const nextLayoutWidth = layoutWidth * factor;
    const container = containerWidth && containerWidth > 0 ? containerWidth : layoutWidth;
    const targetShellWidth = Math.min(nextLayoutWidth, container);
    if (shell) shell.style.width = `${targetShellWidth}px`;
    // stack 的 auto margin：子元素不宽于 shell 时居中，宽于 shell 时左缘贴 shell。
    const stackLeft = layoutWidth <= targetShellWidth ? (targetShellWidth - layoutWidth) / 2 : 0;
    const originX = stackLeft / (layoutWidth * (factor - 1));
    stack.style.transformOrigin = `${(Number.isFinite(originX) ? originX : 0.5) * 100}% 0`;
    stack.style.transform = `scale(${factor})`;
    stack.classList.add("is-live-zooming");
    // 只按 stack 高度补偿（不含页码标签），使实时缩放期间的网格槽高与缩放提交后完全一致：
    // 下方页面不会先下移再回弹，也不会触发多余的 ResizeObserver 重渲染。
    const layoutHeight = baseLayoutHeight ?? (stack.offsetHeight || 1);
    if (shell) shell.style.marginBottom = `${20 + (factor - 1) * layoutHeight}px`;
  } else {
    stack.style.transformOrigin = "50% 0";
    stack.style.transform = "";
    stack.classList.remove("is-live-zooming");
    if (shell) {
      shell.style.width = "";
      shell.style.marginBottom = "";
    }
  }
}

function OriginalPage({
  document: pdfDocument,
  savedPage,
  availableWidth,
  readerRef,
  shouldRender,
  zoom,
  liveZoomRef,
  persistentAnchors,
  highlightRegions,
  pendingColor,
  onJump,
  onOpenUrl,
}: {
  document?: PdfJsDocument;
  savedPage: ParsedPage;
  availableWidth: number;
  readerRef: RefObject<HTMLElement | null>;
  shouldRender: boolean;
  zoom: number;
  liveZoomRef: MutableNumberRef;
  persistentAnchors: TextAnchor[];
  highlightRegions: HighlightRegion[];
  pendingColor?: HighlightColor;
  onJump: (target: CitationTarget) => void;
  onOpenUrl: (url: string) => void;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 离屏渲染用 scratch canvas：尺寸匹配时复用，避免来回缩放时反复分配大块位图内存。
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const persistentHighlightRef = useRef<HTMLDivElement>(null);
  const citationLayerRef = useRef<HTMLDivElement>(null);
  const citationHandlersRef = useRef({ onJump, onOpenUrl });
  citationHandlersRef.current = { onJump, onOpenUrl };
  const highlightDataRef = useRef({ persistentAnchors, highlightRegions, pendingColor });
  const pageRef = useRef<PdfJsPage | null>(null);
  const textContentRef = useRef<Promise<PdfJsTextContent> | null>(null);
  const renderedViewportRef = useRef<PdfJsViewport | undefined>(undefined);
  const renderedZoomRef = useRef(zoom);
  const [baseViewport, setBaseViewport] = useState<PdfJsViewport>();
  const [viewport, setViewport] = useState<PdfJsViewport>();
  const [renderState, setRenderState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    highlightDataRef.current = { persistentAnchors, highlightRegions, pendingColor };
  }, [highlightRegions, pendingColor, persistentAnchors]);

  useEffect(() => {
    let cancelled = false;
    if (!pdfDocument) return;
    void pdfDocument.getPage(savedPage.page).then((page) => {
      if (cancelled) return;
      pageRef.current = page;
      setBaseViewport(page.getViewport({ scale: 1 }));
    });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument, savedPage.page]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const stack = stackRef.current;
    const rendered = renderedViewportRef.current;
    if (!shell || !stack || !rendered) return;
    stack.style.width = `${Math.round(rendered.width)}px`;
    stack.style.height = `${Math.round(rendered.height)}px`;
    const factor = liveZoomRef.current / renderedZoomRef.current;
    applyStackLiveZoom(shell, stack, factor, undefined, undefined, availableWidth);
  }, [availableWidth, baseViewport, liveZoomRef, renderState, savedPage, shouldRender, viewport, zoom]);

  useEffect(() => {
    if (!shouldRender || !baseViewport || !pageRef.current || availableWidth <= 0) return;
    let cancelled = false;
    let renderTask: ReturnType<PdfJsPage["render"]> | undefined;
    let textLayer: InstanceType<PdfJsModule["TextLayer"]> | undefined;
    let textContentPromise = textContentRef.current;
    let pendingTextLayer: HTMLDivElement | undefined;
    let pendingHighlightLayer: HTMLDivElement | undefined;
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;
    const stack = stackRef.current;
    const highlightLayer = persistentHighlightRef.current;
    const shell = shellRef.current;

    const render = async () => {
      const pdfjs = await getPdfJs();
      if (cancelled) return;
      const page = pageRef.current;
      if (!page || !baseViewport) return;
      const fitScale = Math.min(1, availableWidth / baseViewport.width);
      const nextViewport = page.getViewport({ scale: Math.max(0.4, fitScale * zoom) });
      // 位图按 1.25x 栅格余量渲染，实时缩放期间最多 1.25x 内仍保持清晰；
      // 布局与文本层仍用逻辑 viewport，避免产生额外横向滚动条。
      const rasterViewport = page.getViewport({
        scale: Math.max(0.4, fitScale * zoom * RASTER_ZOOM_OVERSCAN),
      });
      if (!canvas || !textLayerContainer || !stack || !highlightLayer) return;

      // 渲染尺寸未变化（例如拖动侧边栏但阅读器仍宽于页面、或窗口尺寸变化不改变
      // 缩放比例）时直接跳过重绘，避免无谓的 canvas 重栅格与文本层重建。
      const rendered = renderedViewportRef.current;
      if (
        rendered &&
        renderedZoomRef.current === zoom &&
        Math.abs(rendered.scale - nextViewport.scale) < 1e-6
      ) {
        return;
      }

      const hasVisibleContent = Boolean(renderedViewportRef.current);
      if (!hasVisibleContent) setRenderState("loading");
      // 高缩放时按像素预算降低有效 DPR：位图尺寸有界，栅格化成本与内存不随缩放平方级增长；
      // 低缩放保持设备 DPR（上限 2），不损失清晰度。
      const budgetRatio = Math.sqrt(
        MAX_RASTER_PIXELS / Math.max(1, rasterViewport.width * rasterViewport.height),
      );
      const pixelRatio = Math.max(
        0.5,
        Math.min(window.devicePixelRatio || 1, 2, budgetRatio),
      );
      const nextCanvasWidth = Math.max(1, Math.ceil(rasterViewport.width * pixelRatio));
      const nextCanvasHeight = Math.max(1, Math.ceil(rasterViewport.height * pixelRatio));
      const scratch = scratchCanvasRef.current;
      const nextCanvas =
        scratch &&
        scratch.width === nextCanvasWidth &&
        scratch.height === nextCanvasHeight
          ? scratch
          : (scratchCanvasRef.current = document.createElement("canvas"));
      nextCanvas.width = nextCanvasWidth;
      nextCanvas.height = nextCanvasHeight;
      const nextContext = nextCanvas.getContext("2d", { alpha: false });
      if (!nextContext) throw new Error("无法创建原版页面画布。");
      nextContext.fillStyle = "#ffffff";
      nextContext.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
      renderTask = page.render({
        canvasContext: nextContext,
        canvas: nextCanvas,
        viewport: rasterViewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });

      textContentPromise ??= page.getTextContent();
      textContentRef.current = textContentPromise;
      const textContent = await textContentPromise;
      if (cancelled) return;

      pendingTextLayer = document.createElement("div");
      pendingTextLayer.className = "original-text-layer";
      pendingTextLayer.style.visibility = "hidden";
      pendingTextLayer.style.setProperty("--total-scale-factor", String(nextViewport.scale));
      stack.append(pendingTextLayer);
      textLayer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: pendingTextLayer,
        viewport: nextViewport,
      });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (cancelled) return;
      spanBoundsForTextLayer(textLayer, savedPage);

      if (cancelled) return;

      canvas.width = nextCanvas.width;
      canvas.height = nextCanvas.height;
      canvas.style.width = `${Math.round(nextViewport.width)}px`;
      canvas.style.height = `${Math.round(nextViewport.height)}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (context) context.drawImage(nextCanvas, 0, 0);

      // 先把新文本层换入 DOM：高亮矩形必须基于新缩放后的 span 计算。
      // 若在换入前计算，stack 里仍残留旧缩放位置的 span（旧文本层还在），
      // 得到的矩形坐标是旧的，换入后高亮就停在旧位置，直到点击才重绘。
      textLayerContainer.replaceChildren(...Array.from(pendingTextLayer.childNodes));
      textLayerContainer.style.setProperty("--total-scale-factor", String(nextViewport.scale));

      pendingHighlightLayer = document.createElement("div");
      pendingHighlightLayer.className = "original-selection-highlight persistent";
      pendingHighlightLayer.dataset.highlightRole = "persistent";
      pendingHighlightLayer.style.visibility = "hidden";
      stack.append(pendingHighlightLayer);
      renderPersistentHighlights(
        stack,
        pendingHighlightLayer,
        savedPage,
        highlightDataRef.current.persistentAnchors,
        highlightDataRef.current.highlightRegions,
        highlightDataRef.current.pendingColor,
      );

      pendingTextLayer.remove();
      highlightLayer.replaceChildren(...Array.from(pendingHighlightLayer.childNodes));
      pendingHighlightLayer.remove();

      renderedViewportRef.current = nextViewport;
      renderedZoomRef.current = zoom;
      stack.dataset.renderedZoom = String(zoom);
      stack.style.width = `${Math.round(nextViewport.width)}px`;
      stack.style.height = `${Math.round(nextViewport.height)}px`;
      applyStackLiveZoom(shell, stack, liveZoomRef.current / zoom, undefined, undefined, availableWidth);

      // 渲染 PDF 原生链接层（基于注解矩形，无文本匹配）。
      // 必须在 stack 尺寸更新之后再计算，否则链接位置会按旧尺寸错位。
      renderPageLinks(
        citationLayerRef.current,
        stack,
        savedPage.links,
        savedPage,
        citationHandlersRef.current.onJump,
        citationHandlersRef.current.onOpenUrl,
      );

      setViewport(nextViewport);
      if (!cancelled) setRenderState("ready");
    };

    void render().catch((error) => {
      if (cancelled || error?.name === "RenderingCancelledException") return;
      setRenderState("error");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      pendingTextLayer?.remove();
      pendingHighlightLayer?.remove();
      if (!shouldRender) {
        renderedViewportRef.current = undefined;
        stack?.removeAttribute("data-rendered-zoom");
        // 实时缩放 transform 现在加在 stack 上，shell 只保留 marginBottom 补偿。
        stack?.classList.remove("is-live-zooming");
        stack?.style.removeProperty("transform");
        if (shell) {
          shell.style.width = "";
          shell.style.marginBottom = "";
        }
        if (canvas) canvas.width = canvas.height = 0;
        textLayerContainer?.replaceChildren();
        highlightLayer?.replaceChildren();
      }
      if (!cancelled) setRenderState("idle");
    };
  }, [availableWidth, baseViewport, liveZoomRef, savedPage, shouldRender, zoom]);

  const persistentAnchorKey = persistentAnchors.map((anchor) => anchor.id).join("|");
  const highlightRegionKey = highlightRegions
    .map((region) => `${region.id}:${region.color}:${region.updatedAt}`)
    .join("|");
  useEffect(() => {
    if (renderState !== "ready" || !shouldRender) return;
    const stack = stackRef.current;
    const layer = persistentHighlightRef.current;
    if (!stack || !layer) return;
    let cancelled = false;
    let retries = 0;
    let timer = 0;
    const draw = () => {
      if (cancelled) return;
      if (!textLayerSpans(stack).length) {
        if (retries < 60) {
          retries += 1;
          timer = window.setTimeout(draw, 60);
        }
        return;
      }
      renderPersistentHighlights(
        stack,
        layer,
        savedPage,
        highlightDataRef.current.persistentAnchors,
        highlightDataRef.current.highlightRegions,
        highlightDataRef.current.pendingColor,
      );
    };
    draw();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      layer.replaceChildren();
    };
  }, [
    // 注意：不依赖 displayZoom。实时缩放是 CSS transform，高亮随 stack 一起缩放；
    // 缩放提交（zoom 变化）后页面按新比例重绘，这里靠 viewport/zoom 依赖重新计算。
    highlightRegionKey,
    highlightRegions,
    pendingColor,
    persistentAnchorKey,
    persistentAnchors,
    renderState,
    savedPage,
    shouldRender,
    viewport,
    zoom,
  ]);

  const baseWidth = savedPage.width || baseViewport?.width || 612;
  const baseHeight = savedPage.height || baseViewport?.height || 792;
  const rotated = Boolean((savedPage.rotation ?? baseViewport?.rotation ?? 0) % 180);
  const ratioWidth = rotated ? baseHeight : baseWidth;
  const ratioHeight = rotated ? baseWidth : baseHeight;
  const style: CSSProperties = viewport
    ? { width: viewport.width, height: viewport.height }
    : {
        width: availableWidth || "100%",
        aspectRatio: `${ratioWidth} / ${ratioHeight}`,
      };

  return (
    <article
      ref={shellRef}
      className="original-page"
      data-page={savedPage.page}
      data-render-state={renderState}
      data-render-window={shouldRender ? "in" : "out"}
    >
      <div className="original-page-meta">
        <span><FileText size={12} /> P.{savedPage.page}</span>
      </div>
      <div ref={stackRef} className="original-page-stack" style={style}>
        <canvas ref={canvasRef} className="original-canvas" aria-label={`第 ${savedPage.page} 页 PDF 原版`} />
        <div ref={textLayerRef} className="original-text-layer" />
        <div ref={persistentHighlightRef} className="original-selection-highlight persistent" data-highlight-role="persistent" />
        <div className="original-selection-highlight current" data-highlight-role="current" />
        <div ref={citationLayerRef} className="original-citation-links" />
        {renderState === "loading" ? (
          <div className="original-page-loading" aria-live="polite"><LoaderCircle className="spin" size={20} /></div>
        ) : null}
        {renderState === "error" ? <div className="original-page-error">原版页面渲染失败</div> : null}
      </div>
    </article>
  );
}

function OriginalPdfView({
  paper,
  readerRef,
  zoom,
  displayZoom,
  liveZoomRef,
  scalingRef,
  persistentAnchors,
  highlightRegions,
  pendingColor,
  onJump,
  onOpenUrl,
}: {
  paper: Paper;
  readerRef: RefObject<HTMLElement | null>;
  zoom: number;
  displayZoom: number;
  liveZoomRef: MutableNumberRef;
  scalingRef: MutableBooleanRef;
  persistentAnchors: TextAnchor[];
  highlightRegions: HighlightRegion[];
  pendingColor?: HighlightColor;
  onJump: (target: CitationTarget) => void;
  onOpenUrl: (url: string) => void;
}) {
  const [document, setDocument] = useState<PdfJsDocument>();
  const [error, setError] = useState<string>();
  const [renderWindow, setRenderWindow] = useState({ start: 1, end: 1 });
  const pagesRef = useRef<HTMLDivElement>(null);
  const availableWidth = useReaderWidth(readerRef, scalingRef, displayZoom);
  const renderFrameRef = useRef<number | null>(null);
  const commitFrameRef = useRef<number | null>(null);

  const updateRenderWindow = useCallback(() => {
    const root = readerRef.current;
    if (!root) return;
    const pageElements = Array.from(root.querySelectorAll<HTMLElement>(".original-page"));
    if (!pageElements.length) return;
    const rootRect = root.getBoundingClientRect();
    const margin = Math.max(320, Math.min(720, rootRect.height));
    const viewportTop = rootRect.top - margin;
    const viewportBottom = rootRect.bottom + margin;
    let start = 0;
    let end = 0;
    for (const element of pageElements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom < viewportTop || rect.top > viewportBottom) continue;
      const page = Number(element.dataset.page) || 1;
      if (!start || page < start) start = page;
      if (page > end) end = page;
    }
    if (!start || !end) return;
    setRenderWindow((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, [readerRef]);

  useEffect(() => {
    const root = readerRef.current;
    const pages = pagesRef.current;
    if (!root) return;

    const schedule = () => {
      if (scalingRef.current) return;
      if (renderFrameRef.current !== null) return;
      renderFrameRef.current = window.requestAnimationFrame(() => {
        renderFrameRef.current = null;
        if (scalingRef.current) return;
        updateRenderWindow();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (pages) observer.observe(pages);
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [availableWidth, document, paper.id, paper.pages.length, readerRef, scalingRef, updateRenderWindow]);

  useEffect(() => {
    if (scalingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      commitFrameRef.current = null;
      if (scalingRef.current) return;
      updateRenderWindow();
    });
    commitFrameRef.current = frame;
    return () => {
      if (commitFrameRef.current !== null) window.cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = null;
    };
  }, [displayZoom, scalingRef, updateRenderWindow]);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PdfJsDocument | undefined;
    void getPdfJs()
      .then(async (pdfjs) => {
        const buffer = new Uint8Array(await paper.file.arrayBuffer());
        loadedDocument = await pdfjs.getDocument({ data: buffer }).promise;
        if (!cancelled) setDocument(loadedDocument);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "无法打开原版 PDF。");
      });
    return () => {
      cancelled = true;
      loadedDocument?.destroy();
    };
  }, [paper.file, paper.id]);

  if (error) return <div className="original-document-error">{error}</div>;

  return (
    <div ref={pagesRef} className="original-pages">
      {paper.pages.map((page) => (
        <OriginalPage
          key={page.page}
          document={document}
          savedPage={page}
          availableWidth={availableWidth}
          readerRef={readerRef}
          zoom={zoom}
          liveZoomRef={liveZoomRef}
          persistentAnchors={persistentAnchors}
          highlightRegions={highlightRegions}
          pendingColor={pendingColor}
          onJump={onJump}
          onOpenUrl={onOpenUrl}
          shouldRender={
            page.page >= renderWindow.start && page.page <= renderWindow.end
          }
        />
      ))}
    </div>
  );
}

function initialReaderZoom() {
  if (typeof window === "undefined") return 1;
  try {
    const raw = window.localStorage.getItem(READER_ZOOM_KEY);
    return raw == null ? 1 : clampReaderZoom(Number(raw));
  } catch {
    return 1;
  }
}

function readerToolbarBottom(reader: HTMLElement): number | undefined {
  const toolbar =
    reader.closest<HTMLElement>(".reader-wrap")?.querySelector<HTMLElement>(".reader-toolbar") ??
    reader.querySelector<HTMLElement>(".reader-toolbar");
  return toolbar?.getBoundingClientRect().bottom;
}

function zoomAnchorForStack(
  reader: HTMLElement,
  stack: HTMLElement,
  clientX: number,
  clientY: number,
  directStack: boolean,
): PendingZoomAnchor | null {
  const rect = stack.getBoundingClientRect();
  const pageElement = stack.closest<HTMLElement>("[data-page]");
  if (!rect.width || !rect.height || !pageElement) return null;
  const toolbarBottom = readerToolbarBottom(reader);
  const onToolbar = Boolean(!directStack && toolbarBottom !== undefined && clientY < toolbarBottom);
  const anchorY = onToolbar && toolbarBottom !== undefined ? toolbarBottom : clientY;
  return {
    page: Number(pageElement.dataset.page) || 1,
    shell: pageElement,
    stack,
    clientX,
    clientY: anchorY,
    xRatio: (clientX - rect.left) / rect.width,
    yRatio: (anchorY - rect.top) / rect.height,
  };
}

/**
 * 解析 Ctrl/Cmd+滚轮缩放的锚点页与比例。xRatio/yRatio 不裁剪，光标位于页面间隙、
 * 左右留白时仍锚定真实光标点。返回 null 仅当阅读器里没有任何页面。
 */
function resolveZoomAnchor(
  reader: HTMLElement,
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): PendingZoomAnchor | null {
  const directStack =
    target instanceof HTMLElement
      ? target.closest<HTMLElement>(".original-page-stack") ??
        target.closest<HTMLElement>(".original-page")?.querySelector<HTMLElement>(".original-page-stack") ??
        undefined
      : undefined;
  const stack = directStack ?? nearestPageStack(reader, clientY);
  if (!stack) return null;
  return zoomAnchorForStack(reader, stack, clientX, clientY, Boolean(directStack));
}

function createZoomSession(
  reader: HTMLElement,
  anchor: PendingZoomAnchor | null,
): ZoomSession | null {
  if (!anchor) return null;
  const containerWidth =
    reader.querySelector<HTMLElement>(".original-pages")?.clientWidth ?? reader.clientWidth;
  const pages: ZoomPageLayout[] = [];
  for (const shell of reader.querySelectorAll<HTMLElement>("[data-page]")) {
    const stack = shell.querySelector<HTMLElement>(".original-page-stack");
    if (!stack) continue;
    const datasetZoom = Number(stack.dataset.renderedZoom);
    const renderedZoom = Number.isFinite(datasetZoom) && datasetZoom > 0 ? datasetZoom : 1;
    pages.push({
      shell,
      stack,
      baseWidth: stack.offsetWidth || 1,
      baseHeight: stack.offsetHeight || 1,
      renderedZoom,
    });
  }
  return pages.length ? { anchor, pages, containerWidth } : null;
}

function applyZoomSession(session: ZoomSession, liveZoom: number) {
  for (const page of session.pages) {
    if (!page.shell.isConnected) continue;
    const datasetZoom = Number(page.stack.dataset.renderedZoom);
    if (Number.isFinite(datasetZoom) && datasetZoom > 0 && datasetZoom !== page.renderedZoom) {
      page.renderedZoom = datasetZoom;
      page.baseWidth = page.stack.offsetWidth || 1;
      page.baseHeight = page.stack.offsetHeight || 1;
    }
    applyStackLiveZoom(
      page.shell,
      page.stack,
      liveZoom / page.renderedZoom,
      page.baseHeight,
      page.baseWidth,
      session.containerWidth,
    );
  }
}

function clearLiveZoomTransforms(reader: HTMLElement) {
  for (const shell of reader.querySelectorAll<HTMLElement>("[data-page]")) {
    const stack = shell.querySelector<HTMLElement>(".original-page-stack");
    if (stack) applyStackLiveZoom(shell, stack, 1);
  }
}

function shouldReuseZoomAnchor(
  reader: HTMLElement,
  anchor: PendingZoomAnchor,
  clientX: number,
  clientY: number,
) {
  const toolbarBottom = readerToolbarBottom(reader);
  if (toolbarBottom !== undefined && clientY < toolbarBottom) return true;
  const shellRect = anchor.shell.getBoundingClientRect();
  const readerRect = reader.getBoundingClientRect();
  const verticalPad = Math.max(80, Math.min(160, shellRect.height * 0.08));
  const horizontalPad = Math.max(160, (readerRect.width - shellRect.width) / 2);
  return (
    clientX >= readerRect.left - 16 &&
    clientX <= readerRect.right + 16 &&
    clientY >= shellRect.top - verticalPad &&
    clientY <= shellRect.bottom + verticalPad
  );
}

/** 取与光标竖向距离最近的页面 stack（用于光标在页面间隙/左右留白上的锚定）。 */
function nearestPageStack(reader: HTMLElement, clientY: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestDistance = Infinity;
  for (const stack of reader.querySelectorAll<HTMLElement>(
    "[data-page] .original-page-stack",
  )) {
    const rect = stack.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (clientY >= rect.top && clientY <= rect.bottom) return stack;
    const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stack;
    }
  }
  return best;
}

function regionIdsAtPoint(
  clientX: number,
  clientY: number,
  tolerance = 0,
): string[] {
  const pieces = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".original-selection-highlight-piece[data-region-id]",
    ),
  );
  const ids = new Set<string>();
  for (const piece of pieces) {
    const rect = piece.getBoundingClientRect();
    if (
      clientX >= rect.left - tolerance &&
      clientX <= rect.right + tolerance &&
      clientY >= rect.top - tolerance &&
      clientY <= rect.bottom + tolerance
    ) {
      const regionId = piece.dataset.regionId;
      if (regionId) ids.add(regionId);
    }
  }
  return [...ids];
}

function popoverPosition() {
  if (typeof window === "undefined") return { left: 16, top: 16 };
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const popoverWidth = Math.min(372, viewportWidth - 16);
  const maxHeight = Math.min(560, viewportHeight - 16);
  const reader = document.querySelector<HTMLElement>(".reader-column");
  const rect = reader?.getBoundingClientRect();
  // 工具栏已移出滚动容器，改用全局查找。
  const toolbar =
    document.querySelector<HTMLElement>(".reader-toolbar") ??
    reader?.querySelector<HTMLElement>(".reader-toolbar");
  const toolbarBottom = toolbar
    ? toolbar.getBoundingClientRect().bottom
    : rect
      ? rect.top + 56
      : 12;
  const preferredLeft = rect
    ? rect.right - popoverWidth - 12
    : viewportWidth - popoverWidth - 12;
  const preferredTop = Math.max(8, toolbarBottom + 8);
  return {
    left: Math.max(8, Math.min(viewportWidth - popoverWidth - 8, preferredLeft)),
    top: Math.max(8, Math.min(preferredTop, viewportHeight - maxHeight - 8)),
  };
}

interface PdfReaderProps {
  paper: Paper;
  activeAnchors: TextAnchor[];
  highlightRegions: HighlightRegion[];
  conversations: Conversation[];
  activeConversationId?: string;
  onDeleteTurn?: (conversation: Conversation, turnId: string) => void;
  outline: PaperSection[];
  requestedChapterPage?: ChapterScrollRequest;
  conversationFocusRequest?: ConversationFocusRequest;
  pendingColor?: HighlightColor;
  onSelectAnchor: (anchor: TextAnchor, additive: boolean) => void;
  onClearSelection: () => void;
  onActiveChapterChange: (next: { sectionId?: string; page?: number }) => void;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  onRestoreLeft?: () => void;
  onRestoreRight?: () => void;
}

export function PdfReader({
  paper,
  activeAnchors,
  highlightRegions,
  conversations,
  activeConversationId,
  onDeleteTurn,
  outline,
  requestedChapterPage,
  conversationFocusRequest,
  pendingColor,
  onSelectAnchor,
  onClearSelection,
  onActiveChapterChange,
  leftCollapsed,
  rightCollapsed,
  onRestoreLeft,
  onRestoreRight,
}: PdfReaderProps) {
  const readerRef = useRef<HTMLElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [pageNumber, setPageNumber] = useState(activeAnchors[0]?.page ?? 1);
  const [zoom, setZoom] = useState(initialReaderZoom);
  const [displayZoom, setDisplayZoom] = useState(initialReaderZoom);
  const liveZoomRef = useRef(zoom);
  const scalingRef = useRef(false);
  const zoomFrameRef = useRef(0);
  const wheelDeltaRef = useRef(0);
  const zoomCommitTimerRef = useRef(0);
  const zoomValueRef = useRef<HTMLButtonElement>(null);
  const zoomOutButtonRef = useRef<HTMLButtonElement>(null);
  const zoomInButtonRef = useRef<HTMLButtonElement>(null);
  const resetZoomButtonRef = useRef<HTMLButtonElement>(null);
  const [panMode, setPanMode] = useState(false);
  const [panActive, setPanActive] = useState(false);
  const [hoveredRegionIds, setHoveredRegionIds] = useState<string[]>([]);
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number }>();
  const [pinnedRegionIds, setPinnedRegionIds] = useState<string[]>([]);
  const [pinnedPoint, setPinnedPoint] = useState<{ x: number; y: number }>();
  const [pinFlashNonce, setPinFlashNonce] = useState(0);
  const activeChapterRef = useRef<{ sectionId?: string; page?: number } | null>(null);
  const suppressSectionSyncRef = useRef(false);
  const chapterScrollTimerRef = useRef(0);
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const onActiveChapterChangeRef = useRef(onActiveChapterChange);
  onActiveChapterChangeRef.current = onActiveChapterChange;
  const hoverRegionRef = useRef<string[]>([]);
  const pinnedRegionRef = useRef<string[]>([]);
  const pinHandledOnPointerUpRef = useRef(false);
  const scrollSuppressUntilRef = useRef(0);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const selectionRef = useRef<{
    pointerId: number;
    stack: HTMLElement;
    page: ParsedPage;
    start: SelectionTextPoint;
    end: SelectionTextPoint;
    additive: boolean;
  } | null>(null);
  const pointerGestureRef = useRef<{
    pointerId: number;
    stack: HTMLElement;
    startX: number;
    startY: number;
    moved: boolean;
    tapRegionIds: string[];
  } | null>(null);
  const pendingZoomRef = useRef<ZoomSession | null>(null);

  const activeAnchor = activeAnchors[0];

  const syncZoomUi = useCallback((value: number) => {
    const valueButton = zoomValueRef.current;
    if (valueButton) {
      valueButton.textContent = `${Math.round(value * 100)}%`;
      valueButton.setAttribute("aria-label", `缩放 ${Math.round(value * 100)}%，点击重置`);
      valueButton.title = "重置为 100%";
    }
    if (zoomOutButtonRef.current) zoomOutButtonRef.current.disabled = value <= MIN_READER_ZOOM;
    if (zoomInButtonRef.current) zoomInButtonRef.current.disabled = value >= MAX_READER_ZOOM;
    if (resetZoomButtonRef.current) resetZoomButtonRef.current.disabled = value === 1;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_ZOOM_KEY, String(zoom));
    } catch {
      // Zoom still works for the current session when localStorage is unavailable.
    }
  }, [zoom]);

  useEffect(() => {
    liveZoomRef.current = zoom;
    syncZoomUi(zoom);
  }, [syncZoomUi, zoom]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    // 监听挂到 .reader-wrap（工具栏已移出滚动容器），保证光标在工具栏上时 Ctrl/Cmd+滚轮也被捕获，
    // 不会触发浏览器整页缩放。
    const host = reader.closest<HTMLElement>(".reader-wrap") ?? reader;

    const scheduleCommit = () => {
      if (zoomCommitTimerRef.current) window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = window.setTimeout(() => {
        zoomCommitTimerRef.current = 0;
        const session = pendingZoomRef.current;
        if (!session) return;
        pendingZoomRef.current = null;
        scalingRef.current = false;
        const next = liveZoomRef.current;
        setDisplayZoom(next);
        setZoom(next);
      }, ZOOM_COMMIT_IDLE_MS);
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const deltaPixels = normalizeReaderWheelDelta(
        event.deltaY,
        event.deltaMode,
        window.innerHeight || reader.clientHeight || 800,
      );
      if (!deltaPixels) return;
      event.preventDefault();

      const session = pendingZoomRef.current;
      const directPage =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-page]")
          : null;
      const directStack = Boolean(
        event.target instanceof HTMLElement &&
          event.target.closest<HTMLElement>(".original-page-stack"),
      );
      const resolveSession = () =>
        createZoomSession(
          reader,
          resolveZoomAnchor(reader, event.target, event.clientX, event.clientY),
        );
      const refreshAnchor = (
        activeSession: ZoomSession,
        anchor: PendingZoomAnchor,
      ) => {
        // 滚轮事件里光标通常不动：保留会话开始时的页面局部坐标作为锚点，滚动补偿
        // 才能收敛到同一个内容点。只有光标实际移动或离开原页面时才重新解析，避免
        // 每帧用已漂移的矩形重算比例，造成锚点持续累积偏移。
        if (
          Math.abs(event.clientX - anchor.clientX) < 3 &&
          Math.abs(event.clientY - anchor.clientY) < 3
        ) {
          return;
        }
        const refreshed = zoomAnchorForStack(
          reader,
          anchor.stack,
          event.clientX,
          event.clientY,
          directStack,
        );
        if (refreshed) activeSession.anchor = refreshed;
        else pendingZoomRef.current = resolveSession();
      };

      if (
        session &&
        directPage &&
        session.anchor?.page === Number(directPage.dataset.page)
      ) {
        refreshAnchor(session, session.anchor);
      } else if (
        session &&
        !directPage &&
        session.anchor &&
        shouldReuseZoomAnchor(reader, session.anchor, event.clientX, event.clientY)
      ) {
        refreshAnchor(session, session.anchor);
      } else {
        pendingZoomRef.current = resolveSession();
      }

      if (!pendingZoomRef.current) return;
      scalingRef.current = true;
      wheelDeltaRef.current += deltaPixels;
      // rAF 合并：一帧内多次滚轮只应用一次连续缩放，不触发 React 状态更新。
      if (!zoomFrameRef.current) {
        zoomFrameRef.current = window.requestAnimationFrame(() => {
          zoomFrameRef.current = 0;
          const activeSession = pendingZoomRef.current;
          const delta = wheelDeltaRef.current;
          wheelDeltaRef.current = 0;
          if (!activeSession) return;
          const next = continuousReaderZoom(liveZoomRef.current, delta);
          if (next === liveZoomRef.current) {
            pendingZoomRef.current = null;
            scalingRef.current = false;
            return;
          }
          liveZoomRef.current = next;
          applyZoomSession(activeSession, next);
          const anchor = activeSession.anchor;
          if (anchor && anchor.stack.isConnected) {
            const rect = anchor.stack.getBoundingClientRect();
            if (rect.width && rect.height) {
              reader.scrollLeft += rect.left + anchor.xRatio * rect.width - anchor.clientX;
              reader.scrollTop += rect.top + anchor.yRatio * rect.height - anchor.clientY;
            }
          }
          syncZoomUi(next);
          scheduleCommit();
        });
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (zoomFrameRef.current) window.cancelAnimationFrame(zoomFrameRef.current);
      zoomFrameRef.current = 0;
      if (zoomCommitTimerRef.current) window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = 0;
      wheelDeltaRef.current = 0;
      host.removeEventListener("wheel", onWheel);
    };
  }, [readerRef, syncZoomUi]);

  useEffect(() => {
    if (!panMode) return;
    window.getSelection()?.removeAllRanges();
    clearCurrentSelectionHighlights(readerRef.current);
  }, [panMode]);

  useEffect(() => {
    setPageNumber(activeAnchor?.page ?? 1);
    activeChapterRef.current = null;
    onActiveChapterChangeRef.current({});
  }, [activeAnchor?.page, paper.id]);

  useEffect(() => {
    if (!activeAnchor?.page) return;
    const reader = readerRef.current;
    const element = reader?.querySelector<HTMLElement>(`[data-page="${activeAnchor.page}"]`);
    if (!reader || !element) return;
    // 划选产生锚点时用户正停留在该页，此时 scrollIntoView(block:"start") 会把
    // 视图拽回页首（顶部页甚至回到阅读器顶部），造成“划选后突然回滚”。
    // 仅当目标页不在阅读器可视区内（例如从右侧问答列表跳转）时才滚动。
    const readerRect = reader.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const margin = 72;
    const isVisible =
      elementRect.top < readerRect.bottom - margin &&
      elementRect.bottom > readerRect.top + margin;
    if (isVisible) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeAnchor?.page, paper.id]);

  useEffect(() => {
    if (!requestedChapterPage) return;
    const reader = readerRef.current;
    const section = outlineRef.current.find(
      (entry) => entry.id === requestedChapterPage.sectionId,
    );
    const pageElement = reader?.querySelector<HTMLElement>(
      `[data-page="${requestedChapterPage.page}"]`,
    );
    const stack = pageElement?.querySelector<HTMLElement>(".original-page-stack");
    const pageData = paperRef.current.pages.find(
      (page) => page.page === requestedChapterPage.page,
    );
    if (!reader || !pageElement || !stack) return;

    setPageNumber(requestedChapterPage.page);
    activeChapterRef.current = {
      sectionId: section?.id,
      page: requestedChapterPage.page,
    };
    onActiveChapterChangeRef.current(activeChapterRef.current);
    suppressSectionSyncRef.current = true;
    const clearSuppress = () => {
      suppressSectionSyncRef.current = false;
    };
    chapterScrollTimerRef.current = window.setTimeout(clearSuppress, 700);

    const readerRect = reader.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    const ratio =
      pageData && section
        ? sectionHeadingTopRatio(pageData, section.title) ?? 0
        : 0;
    const targetTop = stackRect.top + ratio * stackRect.height;
    reader.scrollTo({
      top: reader.scrollTop + (targetTop - readerRect.top - reader.clientHeight * 0.3),
      behavior: "smooth",
    });

    const flash = document.createElement("div");
    flash.className = "section-target-flash";
    flash.style.top = `${ratio * 100}%`;
    stack.append(flash);
    const removeFlash = () => flash.remove();
    const timer = window.setTimeout(removeFlash, 1400);
    flash.addEventListener("animationend", removeFlash, { once: true });

    return () => {
      window.clearTimeout(chapterScrollTimerRef.current);
      chapterScrollTimerRef.current = 0;
      suppressSectionSyncRef.current = false;
      window.clearTimeout(timer);
      flash.remove();
      flash.removeEventListener("animationend", removeFlash);
    };
  }, [requestedChapterPage]);

  useEffect(() => {
    if (!conversationFocusRequest?.anchors.length) return;
    const { conversationId, anchors } = conversationFocusRequest;
    const firstPage = anchors[0].page;
    setPageNumber(firstPage);
    const pageElement = readerRef.current?.querySelector<HTMLElement>(
      `[data-page="${firstPage}"]`,
    );
    pageElement?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });

    let cancelled = false;
    let attempt = 0;
    let timer = 0;
    let focusTimer = 0;
    const tick = () => {
      if (cancelled) return;
      const targets = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".original-selection-highlight-piece[data-conversation-ids]",
        ),
      ).filter((piece) => {
        try {
          const ids = JSON.parse(piece.dataset.conversationIds ?? "[]") as string[];
          return ids.includes(conversationId);
        } catch {
          return false;
        }
      });
      if (targets.length) {
        targets[0].scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        for (const target of targets) {
          target.classList.remove("highlight-conversation-focus");
          void target.offsetWidth;
          target.classList.add("highlight-conversation-focus");
        }
        focusTimer = window.setTimeout(() => {
          for (const target of targets) {
            target.classList.remove("highlight-conversation-focus");
          }
        }, 1700);
        return;
      }
      attempt += 1;
      if (attempt < 35) {
        timer = window.setTimeout(tick, 120);
      }
    };
    timer = window.setTimeout(tick, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(focusTimer);
      document
        .querySelectorAll<HTMLElement>(".highlight-conversation-focus")
        .forEach((element) => element.classList.remove("highlight-conversation-focus"));
    };
  }, [conversationFocusRequest]);

  useEffect(() => () => {
    if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    if (!pinFlashNonce) return;
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".original-selection-highlight-piece[data-region-id]",
      ),
    ).filter((element) =>
      pinnedRegionRef.current.includes(element.dataset.regionId ?? ""),
    );
    if (!targets.length) return;
    for (const target of targets) {
      target.classList.remove("highlight-pin-flash");
      void target.offsetWidth;
      target.classList.add("highlight-pin-flash");
    }
    const timer = window.setTimeout(() => {
      for (const target of targets) {
        target.classList.remove("highlight-pin-flash");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [pinFlashNonce]);

  useEffect(() => {
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && readerRef.current?.contains(target)) return;
      hoverRegionRef.current = [];
      pinnedRegionRef.current = [];
      setHoveredRegionIds([]);
      setHoverPoint(undefined);
      setPinnedRegionIds([]);
      setPinnedPoint(undefined);
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, []);

  function syncSection(page: number) {
    if (suppressSectionSyncRef.current) return;
    const reader = readerRef.current;
    const fallbackSection = sectionForPage(outlineRef.current, page);
    let bestSection = fallbackSection;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const section of outlineRef.current) {
      if (section.page !== page) continue;
      const sectionTop = reader
        ? sectionStartTop(reader, paperRef.current, section)
        : undefined;
      if (sectionTop === undefined) continue;
      const distance = Math.abs(
        sectionTop - reader!.getBoundingClientRect().top - reader!.clientHeight * 0.3,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSection = section;
      }
    }
    const next = { sectionId: bestSection?.id, page };
    if (
      next.sectionId === activeChapterRef.current?.sectionId &&
      next.page === activeChapterRef.current?.page
    ) {
      return;
    }
    activeChapterRef.current = next;
    onActiveChapterChangeRef.current(next);
  }

  function goToPage(page: number) {
    if (page < 1 || page > paper.pageCount) return;
    setPageNumber(page);
    syncSection(page);
    readerRef.current
      ?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function jumpToCitation(target: CitationTarget) {
    const reader = readerRef.current;
    if (!reader) return;
    const pageData = paper.pages.find((entry) => entry.page === target.page);
    const pageElement = reader.querySelector<HTMLElement>(`[data-page="${target.page}"]`);
    const stack = pageElement?.querySelector<HTMLElement>(".original-page-stack");
    if (!pageElement || !stack || !pageData?.height) return;
    setPageNumber(target.page);
    syncSection(target.page);
    // 直接按目标纵坐标（scale=1 视口坐标，y 向下）计算滚动位置，避免
    // 先 scrollIntoView 再微调造成的“先拽回页首再回落”抖动；目标页未渲染时
    // stack 的布局尺寸仍为真实页面比例，计算依然有效。
    const readerRect = reader.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, target.top / pageData.height!));
    // stackRect.height 已包含缩放后的高度（getBoundingClientRect 计入 transform），
    // 用它在缩放状态下也能定位到正确的目标位置。
    const targetY = stackRect.top + ratio * stackRect.height;
    reader.scrollTo({
      top: reader.scrollTop + (targetY - readerRect.top - reader.clientHeight * 0.32),
      behavior: "auto",
    });
    // 目标位置闪烁提示。
    const flash = document.createElement("div");
    flash.className = "citation-target-flash";
    flash.style.top = `${ratio * 100}%`;
    stack.append(flash);
    const removeFlash = () => flash.remove();
    window.setTimeout(removeFlash, 1400);
    flash.addEventListener("animationend", removeFlash, { once: true });
  }

  function openExternalUrl(url: string) {
    if (/^https?:\/\//i.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function handleScroll(event?: React.UIEvent<HTMLElement>) {
    if (scalingRef.current) return;
    if (event && event.target !== event.currentTarget) return;
    scrollSuppressUntilRef.current = performance.now() + 180;
    closeHoverHighlightPopover();
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = readerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let current = 1;
      for (const section of container.querySelectorAll<HTMLElement>("[data-page]")) {
        if (section.getBoundingClientRect().top <= rect.top + 150) {
          current = Number(section.dataset.page) || current;
        } else {
          break;
        }
      }
      setPageNumber((previous) => (previous === current ? previous : current));
      syncSection(current);
    });
  }

  function changeZoom(nextZoom: number) {
    pendingZoomRef.current = null;
    if (zoomFrameRef.current) window.cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = 0;
    wheelDeltaRef.current = 0;
    if (zoomCommitTimerRef.current) window.clearTimeout(zoomCommitTimerRef.current);
    zoomCommitTimerRef.current = 0;
    scalingRef.current = false;
    closeHighlightPopover();
    const clamped = clampReaderZoom(nextZoom);
    liveZoomRef.current = clamped;
    if (readerRef.current) clearLiveZoomTransforms(readerRef.current);
    setDisplayZoom(clamped);
    setZoom(clamped);
  }

  function closeHighlightPopover() {
    closeHoverHighlightPopover();
    closePinnedHighlightPopover();
  }

  function closeHoverHighlightPopover() {
    hoverRegionRef.current = [];
    setHoveredRegionIds([]);
    setHoverPoint(undefined);
  }

  function closePinnedHighlightPopover() {
    pinnedRegionRef.current = [];
    setPinnedRegionIds([]);
    setPinnedPoint(undefined);
  }

  function pinRegionAtPoint(clientX: number, clientY: number) {
    const regionIds = regionIdsAtPoint(clientX, clientY);
    if (!regionIds.length) return false;
    closeHoverHighlightPopover();
    pinnedRegionRef.current = regionIds;
    setPinnedPoint({ x: clientX, y: clientY });
    setPinnedRegionIds(regionIds);
    setPinFlashNonce((nonce) => nonce + 1);
    // 点击高亮注释 = 划选这段高亮内容，可直接在右侧对话中提问。
    const region = highlightRegions.find((entry) => regionIds.includes(entry.id));
    if (region) {
      onSelectAnchor(region.anchor, false);
    }
    return true;
  }

  function startPan(event: ReactPointerEvent<HTMLElement>) {
    closeHighlightPopover();
    if (!panMode || !readerRef.current) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, input, textarea, select, a")
    ) {
      return;
    }
    event.preventDefault();
    const reader = readerRef.current;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: reader.scrollLeft,
      scrollTop: reader.scrollTop,
    };
    setPanActive(true);
    reader.setPointerCapture?.(event.pointerId);
  }

  function movePan(event: ReactPointerEvent<HTMLElement>) {
    const pan = panRef.current;
    const reader = readerRef.current;
    if (!pan || !reader || event.pointerId !== pan.pointerId) return;
    reader.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    reader.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }

  function endPan(event: ReactPointerEvent<HTMLElement>) {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) return;
    panRef.current = null;
    setPanActive(false);
    readerRef.current?.releasePointerCapture?.(event.pointerId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    pinHandledOnPointerUpRef.current = false;
    if (panMode) {
      startPan(event);
      return;
    }
    if (event.button !== 0 || !readerRef.current) return;
    const target = event.target;
    const stack =
      target instanceof Element
        ? target.closest<HTMLElement>(".original-page-stack") ?? undefined
        : undefined;
    if (!stack) return;
    pointerGestureRef.current = {
      pointerId: event.pointerId,
      stack,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      tapRegionIds: regionIdsAtPoint(event.clientX, event.clientY),
    };
    const start = selectionPointAtPosition(
      stack,
      undefined,
      event.clientX,
      event.clientY,
    );
    if (!start) return;
    const pageValue = Number(stack.parentElement?.getAttribute("data-page"));
    const page = paper.pages.find((entry) => entry.page === pageValue);
    if (!page) return;

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    selectionRef.current = {
      pointerId: event.pointerId,
      stack,
      page,
      start,
      end: start,
      additive: event.ctrlKey || event.metaKey,
    };
    readerRef.current.setPointerCapture?.(event.pointerId);
    renderCurrentSelectionBetweenPoints(readerRef.current, page, start, start);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (panMode) {
      movePan(event);
      return;
    }
    const gesture = pointerGestureRef.current;
    if (
      gesture &&
      event.pointerId === gesture.pointerId &&
      !gesture.moved &&
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >
        CLICK_MOVE_THRESHOLD
    ) {
      gesture.moved = true;
    }
    if (
      event.pointerType !== "touch" &&
      !selectionRef.current &&
      !gesture?.moved
    ) {
      if (
        event.target instanceof Element &&
        event.target.closest(".highlight-popover")
      ) {
        return;
      }
      if (pinnedRegionRef.current.length) return;
      if (performance.now() < scrollSuppressUntilRef.current) return;
      const regionIds = regionIdsAtPoint(event.clientX, event.clientY, 6);
      const currentKey = hoverRegionRef.current.join("|");
      const nextKey = regionIds.join("|");
      if (regionIds.length && currentKey !== nextKey) {
        const previousIds = hoverRegionRef.current;
        const staysOnSameRegion = previousIds.some((id) =>
          regionIds.includes(id),
        );
        hoverRegionRef.current = regionIds;
        if (!previousIds.length || !staysOnSameRegion) {
          setHoverPoint({ x: event.clientX, y: event.clientY });
        }
        setHoveredRegionIds(regionIds);
      } else if (!regionIds.length && hoverRegionRef.current.length) {
        closeHighlightPopover();
      }
    } else if (gesture?.moved && hoverRegionRef.current.length) {
      closeHighlightPopover();
    }
    const selection = selectionRef.current;
    if (!selection || event.pointerId !== selection.pointerId) return;
    const stack =
      stackForPoint(event.clientX, event.clientY) ?? selection.stack;
    const end = selectionPointAtPosition(
      stack,
      selection.start,
      event.clientX,
      event.clientY,
    );
    if (!end) return;
    selection.end = end;
    renderCurrentSelectionBetweenPoints(
      readerRef.current,
      selection.page,
      selection.start,
      end,
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (panMode) {
      endPan(event);
      return;
    }
    const gesture = pointerGestureRef.current;
    const tapRegionIds = gesture?.tapRegionIds;
    if (gesture?.pointerId === event.pointerId) {
      pointerGestureRef.current = null;
    }
    const isSameStackClick = Boolean(
      gesture &&
        !gesture.moved &&
        gesture.stack,
    );
    const selection = selectionRef.current;
    if (!selection || event.pointerId !== selection.pointerId) {
      if (isSameStackClick && tapRegionIds?.length) {
        pinHandledOnPointerUpRef.current = pinRegionAtPoint(
          event.clientX,
          event.clientY,
        );
      } else if (isSameStackClick) {
        onClearSelection();
      }
      return;
    }
    selectionRef.current = null;
    readerRef.current?.releasePointerCapture?.(event.pointerId);
    const end =
      selectionPointAtPosition(
        selection.stack,
        selection.start,
        event.clientX,
        event.clientY,
      ) ?? selection.end;
    const selected = selectionItemsBetweenPoints(
      selection.page,
      selection.stack,
      selection.start,
      end,
    );
    window.getSelection()?.removeAllRanges();
    clearCurrentSelectionHighlights(readerRef.current);
    if (!selected || selected.quote.length < 3) {
      if (isSameStackClick && tapRegionIds?.length) {
        pinHandledOnPointerUpRef.current = pinRegionAtPoint(
          event.clientX,
          event.clientY,
        );
      } else if (isSameStackClick) {
        onClearSelection();
      }
      return;
    }

    onSelectAnchor(
      makeAnchor(
        paper.id,
        selection.page,
        selected.quote,
        findQuoteStart(selection.page, selected.quote),
        outlineRef.current.find(
          (section) => section.id === activeChapterRef.current?.sectionId,
        )?.title ??
          sectionForPage(outlineRef.current, selection.page.page)?.title,
        {
          blockIds: selected.blockIds,
          textItemStart: selected.textItemStart,
          textItemEnd: selected.textItemEnd,
          textStartOffset: selected.textStartOffset,
          textEndOffset: selected.textEndOffset,
        },
      ),
      selection.additive,
    );
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (panMode) {
      endPan(event);
      return;
    }
    const gesture = pointerGestureRef.current;
    if (gesture?.pointerId === event.pointerId) {
      pointerGestureRef.current = null;
    }
    const selection = selectionRef.current;
    if (!selection || event.pointerId !== selection.pointerId) return;
    selectionRef.current = null;
    readerRef.current?.releasePointerCapture?.(event.pointerId);
    window.getSelection()?.removeAllRanges();
    clearCurrentSelectionHighlights(readerRef.current);
  }

  function handlePointerLeave() {
    closeHoverHighlightPopover();
  }

  function handleReaderClick(event: ReactPointerEvent<HTMLElement>) {
    if (
      panMode ||
      !readerRef.current ||
      !readerRef.current.contains(event.target as Node) ||
      (event.target instanceof Element &&
        Boolean(event.target.closest(".highlight-popover")))
    ) {
      return;
    }
    if (pinHandledOnPointerUpRef.current) {
      pinHandledOnPointerUpRef.current = false;
      return;
    }
    const stack =
      event.target instanceof Element
        ? event.target.closest(".original-page-stack")
        : null;
    if (!stack || !pinRegionAtPoint(event.clientX, event.clientY)) {
      closeHighlightPopover();
    }
  }

  return (
    <div className="reader-wrap">
      <div className="reader-toolbar">
        <div className="reader-restore reader-restore-left">
          {leftCollapsed ? (
            <button type="button" onClick={onRestoreLeft}><PanelLeftOpen size={14} /> 展开左侧</button>
          ) : null}
        </div>
        <div className="reader-toolbar-center">
          <div className="reader-toolbar-group">
            <div className="reader-page-control">
              <button aria-label="上一页" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>
                <ChevronLeft size={17} />
              </button>
              <span>第 {pageNumber} / {paper.pageCount} 页</span>
              <button aria-label="下一页" disabled={pageNumber >= paper.pageCount} onClick={() => goToPage(pageNumber + 1)}>
                <ChevronRight size={17} />
              </button>
            </div>
            <div className="reader-zoom-control">
              <button
                type="button"
                ref={zoomOutButtonRef}
                aria-label="缩小"
                title="缩小"
                disabled={displayZoom <= 0.5}
                onClick={() => changeZoom(stepReaderZoom(liveZoomRef.current, -1))}
              >
                <ZoomOut size={15} />
              </button>
              <button
                type="button"
                ref={zoomValueRef}
                className="zoom-value"
                aria-label={`缩放 ${Math.round(displayZoom * 100)}%，点击重置`}
                title="重置为 100%"
                onClick={() => changeZoom(1)}
              >
                {Math.round(displayZoom * 100)}%
              </button>
              <button
                type="button"
                ref={zoomInButtonRef}
                aria-label="放大"
                title="放大"
                disabled={displayZoom >= 3}
                onClick={() => changeZoom(stepReaderZoom(liveZoomRef.current, 1))}
              >
                <ZoomIn size={15} />
              </button>
              <button
                type="button"
                ref={resetZoomButtonRef}
                aria-label="重置缩放"
                title="重置为 100%"
                disabled={displayZoom === 1}
                onClick={() => changeZoom(1)}
              >
                <RotateCcw size={14} />
              </button>
              <button
                type="button"
                className={panMode ? "active" : ""}
                aria-pressed={panMode}
                aria-label={panMode ? "退出拖动模式" : "进入拖动模式"}
                title={panMode ? "退出拖动模式" : "拖动模式"}
                onClick={() => setPanMode((current) => !current)}
              >
                <Hand size={15} />
              </button>
            </div>
          </div>
          <span className="selection-tip"><MousePointer2 size={14} /> 划选提问 · Ctrl/Cmd 追加</span>
        </div>
        <div className="reader-restore reader-restore-right">
          {rightCollapsed ? (
            <button type="button" onClick={onRestoreRight}><PanelRightOpen size={14} /> 展开右侧</button>
          ) : null}
        </div>
      </div>
      <section
        className={`reader-column ${panMode ? "pan-mode" : ""} ${panActive ? "is-dragging" : ""}`}
        ref={readerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onClick={handleReaderClick}
        onScroll={handleScroll}
        aria-label="论文阅读器"
      >
      <OriginalPdfView
        paper={paper}
        readerRef={readerRef}
        zoom={zoom}
        displayZoom={displayZoom}
        liveZoomRef={liveZoomRef}
        scalingRef={scalingRef}
        persistentAnchors={activeAnchors}
        highlightRegions={highlightRegions}
        pendingColor={pendingColor}
        onJump={jumpToCitation}
        onOpenUrl={openExternalUrl}
      />
      {pinnedRegionIds.length && pinnedPoint ? (
        <HighlightPopover
          regionIds={pinnedRegionIds}
          regions={highlightRegions}
          conversations={conversations}
          activeConversationId={activeConversationId}
          point={pinnedPoint}
          pinned
          onDeleteTurn={onDeleteTurn}
        />
      ) : hoveredRegionIds.length && hoverPoint ? (
        <HighlightPopover
          regionIds={hoveredRegionIds}
          regions={highlightRegions}
          conversations={conversations}
          activeConversationId={activeConversationId}
          point={hoverPoint}
          onDeleteTurn={onDeleteTurn}
        />
      ) : null}
      </section>
    </div>
  );
}

function readableTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

interface HighlightPopoverProps {
  regionIds: string[];
  regions: HighlightRegion[];
  conversations: Conversation[];
  activeConversationId?: string;
  point: { x: number; y: number };
  pinned?: boolean;
  onDeleteTurn?: (conversation: Conversation, turnId: string) => void;
}

function HighlightPopover({
  regionIds,
  regions,
  conversations,
  point,
  pinned = false,
  onDeleteTurn,
}: HighlightPopoverProps) {
  const matchedRegions = useMemo(
    () =>
      regionIds
        .map((regionId) => regions.find((region) => region.id === regionId))
        .filter((region): region is HighlightRegion => Boolean(region)),
    [regionIds, regions],
  );
  const relatedConversations = useMemo(() => {
    const regionConversationIds = new Set(
      matchedRegions.flatMap((region) => region.conversationIds),
    );
    return conversations
      .filter((conversation) => regionConversationIds.has(conversation.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [conversations, matchedRegions]);
  const indexItems = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ conversation: Conversation; turn: ChatTurn }> = [];
    for (const conversation of relatedConversations) {
      for (const turn of [...conversation.turns].reverse()) {
        const dedupeKey = `${turn.kind ?? "normal"}:${conversation.scope ?? "normal"}:${turn.content}`;
        if (turn.role !== "user" || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        items.push({ conversation, turn });
      }
    }
    return items;
  }, [relatedConversations]);
  const [recordsConversation, setRecordsConversation] = useState<Conversation>();
  useEffect(() => {
    setRecordsConversation((current) => {
      if (current && relatedConversations.some((item) => item.id === current.id)) {
        return current;
      }
      return relatedConversations[0];
    });
  }, [relatedConversations]);
  const [position, setPosition] = useState(popoverPosition);
  useEffect(() => {
    setPosition(popoverPosition());
  }, [point]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // 当前选中的问答记录：问答索引只高亮这一条，对话记录滚动到对应位置。
  const [selectedTurnId, setSelectedTurnId] = useState<string>();
  const recordsListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setSelectedTurnId((current) => {
      if (recordsConversation && recordsConversation.turns.some((turn) => turn.id === current)) {
        return current;
      }
      const lastUserTurn = [...(recordsConversation?.turns ?? [])]
        .reverse()
        .find((turn) => turn.role === "user");
      return lastUserTurn?.id;
    });
  }, [recordsConversation]);

  function selectIndexTurn(conversation: Conversation, turnId: string) {
    setSelectedTurnId(turnId);
    if (recordsConversation?.id !== conversation.id) {
      setRecordsConversation(conversation);
    }
    // 滚动浮窗下方的对话记录到对应记录（不滚动阅读窗口）。
    requestAnimationFrame(() => {
      const target = recordsListRef.current?.querySelector(
        `[data-turn-id="${turnId}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);

  function startPopoverDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePopoverDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const popoverWidth = Math.min(372, viewportWidth - 16);
    const popoverHeight = Math.max(
      1,
      Math.min(popoverRef.current?.offsetHeight ?? 560, viewportHeight - 16),
    );
    const maxLeft = Math.max(8, viewportWidth - popoverWidth - 8);
    const maxTop = Math.max(8, viewportHeight - popoverHeight - 8);
    setPosition({
      left: Math.max(8, Math.min(maxLeft, drag.left + event.clientX - drag.startX)),
      top: Math.max(8, Math.min(maxTop, drag.top + event.clientY - drag.startY)),
    });
  }

  function endPopoverDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  const pages = [...new Set(matchedRegions.map((region) => region.anchor.page))].sort(
    (a, b) => a - b,
  );
  const colors = [...new Set(matchedRegions.map((region) => region.color))];
  const latestUpdatedAt = matchedRegions.reduce(
    (latest, region) =>
      region.updatedAt.localeCompare(latest) > 0 ? region.updatedAt : latest,
    matchedRegions[0]?.updatedAt ?? "",
  );

  if (!matchedRegions.length) return null;

  return (
    <div
      ref={popoverRef}
      className="highlight-popover"
      role="dialog"
      aria-label="选区问答记录"
      style={{ left: position.left, top: position.top }}
    >
      <div className="highlight-popover-header">
        {pinned ? (
          <button
            type="button"
            className="highlight-popover-drag-handle"
            aria-label="拖动浮窗"
            title="拖动浮窗"
            onPointerDown={startPopoverDrag}
            onPointerMove={movePopoverDrag}
            onPointerUp={endPopoverDrag}
            onPointerCancel={endPopoverDrag}
          >
            <GripVertical size={14} />
          </button>
        ) : null}
        <span className="highlight-popover-color-row" aria-hidden="true">
          {colors.map((color) => (
            <span
              key={color}
              className={`highlight-color-dot highlight-color-dot-${color}`}
            />
          ))}
        </span>
        <div>
          <strong>
            {pages.length > 1
              ? `第 ${pages.join("/")} 页选区`
              : `第 ${pages[0] ?? "?"} 页选区`}
          </strong>
          <span>共 {relatedConversations.length} 段问答</span>
        </div>
        <small>{latestUpdatedAt ? readableTime(latestUpdatedAt) : ""}</small>
      </div>
      <div className="highlight-popover-index">
        <div className="highlight-popover-section-label">
          <span>问答索引</span>
          <b>{indexItems.length}</b>
        </div>
        {indexItems.length ? (
          <div className="highlight-popover-index-list">
            {indexItems.map((item) => {
              const conversation = item.conversation;
              const color = conversation.color ?? "sage";
              const page = item.turn.selection?.anchors.length
                ? [...new Set(item.turn.selection.anchors.map((entry) => entry.page))].join("/")
                : conversation.anchor?.page ?? matchedRegions[0]?.anchor.page ?? "?";
              return (
                <div
                  key={item.turn.id}
                  className={`highlight-popover-index-item ${selectedTurnId === item.turn.id ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="highlight-popover-index-item-main"
                    onClick={() => selectIndexTurn(item.conversation, item.turn.id)}
                  >
                    <span className={`highlight-color-dot highlight-color-dot-${color}`} aria-hidden="true" />
                    <span className="highlight-popover-page">
                      p.{page}
                      {conversation.scope === "context" || item.turn.kind === "context" ? (
                        <span className="index-badge">全文</span>
                      ) : null}
                    </span>
                    <span className="highlight-popover-question">
                      {formatAnchorExcerpt(item.turn.content, 36, 18)}
                    </span>
                    <time>{readableTime(item.turn.createdAt)}</time>
                  </button>
                  <button
                    type="button"
                    className="highlight-popover-index-item-delete"
                    aria-label="删除这条问答记录"
                    title="删除这条问答记录"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onDeleteTurn?.(item.conversation, item.turn.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="highlight-popover-empty">这个选区还没有提问。</p>
        )}
      </div>
      <div className="highlight-popover-records">
        <div className="highlight-popover-section-label">
          <span>对话记录</span>
          <b>{recordsConversation ? readableTime(recordsConversation.updatedAt) : "暂无"}</b>
        </div>
        {recordsConversation?.turns.length ? (
          <div ref={recordsListRef} className="highlight-popover-turn-list">
            {recordsConversation.turns.map((turn) => (
              <div
                key={turn.id}
                data-turn-id={turn.id}
                className={`highlight-popover-turn ${turn.role} ${selectedTurnId === turn.id ? "selected" : ""}`}
              >
                <span>{turn.role === "user" ? "你" : "PaperMate"}</span>
                {turn.role === "user" ? (
                  <p>{turn.content}</p>
                ) : (
                  <div className="md-body">
                    {turn.content ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                      >
                        {turn.content}
                      </ReactMarkdown>
                    ) : (
                      <LoaderCircle className="spin" size={14} />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="highlight-popover-empty">暂无对话内容。</p>
        )}
      </div>
    </div>
  );
}
