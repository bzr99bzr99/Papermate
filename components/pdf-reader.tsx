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
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  clampReaderZoom,
  formatAnchorExcerpt,
  flattenPdfOutline,
  inferSectionsFromPages,
  makeAnchor,
  paragraphBlocksFromLines,
  stepReaderZoom,
  textLinesFromItems,
} from "@/lib/pdf";
import type { PdfOutlineNode } from "@/lib/pdf";
import type {
  Conversation,
  ChatTurn,
  HighlightColor,
  HighlightRegion,
  Paper,
  PaperSection,
  ParsedPage,
  PdfTextItem,
  TextAnchor,
} from "@/lib/types";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfJsDocument = Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>;
type PdfJsPage = Awaited<ReturnType<PdfJsDocument["getPage"]>>;

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
      pages.push({
        page: pageNumber,
        text: blocks.map((block) => block.text).join("\n"),
        blocks,
        figures: [],
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
const ZOOM_COMMIT_DELAY_MS = 90;
const CLICK_MOVE_THRESHOLD = 5;

interface PendingZoomAnchor {
  page: number;
  clientX: number;
  clientY: number;
  xRatio: number;
  yRatio: number;
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
    );
  }
}

function clearCurrentSelectionHighlights(root: HTMLElement | null | undefined) {
  root
    ?.querySelectorAll<HTMLElement>('[data-highlight-role="current"]')
    .forEach((layer) => layer.replaceChildren());
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

function useReaderWidth(readerRef: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = readerRef.current;
    if (!element) return;
    const measure = () => {
      const style = window.getComputedStyle(element);
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      setWidth(Math.max(260, element.clientWidth - horizontalPadding));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [readerRef]);

  return width;
}

function applyStackLiveZoom(
  shell: HTMLElement | null,
  stack: HTMLElement,
  factor: number,
) {
  stack.style.transformOrigin = "0 0";
  if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
    stack.style.transform = `scale(${factor})`;
    stack.classList.add("is-live-zooming");
    const layoutHeight = stack.offsetHeight || 1;
    if (shell) shell.style.marginBottom = `${20 + (factor - 1) * layoutHeight}px`;
  } else {
    stack.style.transform = "";
    stack.classList.remove("is-live-zooming");
    if (shell) shell.style.marginBottom = "";
  }
}

function OriginalPage({
  document: pdfDocument,
  savedPage,
  availableWidth,
  readerRef,
  shouldRender,
  zoom,
  displayZoom,
  persistentAnchors,
  highlightRegions,
}: {
  document?: PdfJsDocument;
  savedPage: ParsedPage;
  availableWidth: number;
  readerRef: RefObject<HTMLElement | null>;
  shouldRender: boolean;
  zoom: number;
  displayZoom: number;
  persistentAnchors: TextAnchor[];
  highlightRegions: HighlightRegion[];
}) {
  const shellRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const persistentHighlightRef = useRef<HTMLDivElement>(null);
  const highlightDataRef = useRef({ persistentAnchors, highlightRegions });
  const pageRef = useRef<PdfJsPage | null>(null);
  const textContentRef = useRef<Promise<PdfJsTextContent> | null>(null);
  const renderedViewportRef = useRef<PdfJsViewport | undefined>(undefined);
  const renderedZoomRef = useRef(zoom);
  const displayZoomRef = useRef(displayZoom);
  displayZoomRef.current = displayZoom;
  const [baseViewport, setBaseViewport] = useState<PdfJsViewport>();
  const [viewport, setViewport] = useState<PdfJsViewport>();
  const [renderState, setRenderState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    highlightDataRef.current = { persistentAnchors, highlightRegions };
  }, [highlightRegions, persistentAnchors]);

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
    const factor = displayZoom / renderedZoomRef.current;
    applyStackLiveZoom(shell, stack, factor);
  }, [availableWidth, baseViewport, displayZoom, renderState, savedPage, shouldRender, viewport, zoom]);

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
      if (!canvas || !textLayerContainer || !stack || !highlightLayer) return;

      const hasVisibleContent = Boolean(renderedViewportRef.current);
      if (!hasVisibleContent) setRenderState("loading");
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextCanvas = document.createElement("canvas");
      nextCanvas.width = Math.max(1, Math.ceil(nextViewport.width * pixelRatio));
      nextCanvas.height = Math.max(1, Math.ceil(nextViewport.height * pixelRatio));
      const nextContext = nextCanvas.getContext("2d", { alpha: false });
      if (!nextContext) throw new Error("无法创建原版页面画布。");
      nextContext.fillStyle = "#ffffff";
      nextContext.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
      renderTask = page.render({
        canvasContext: nextContext,
        canvas: nextCanvas,
        viewport: nextViewport,
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
      );
      if (cancelled) return;

      canvas.width = nextCanvas.width;
      canvas.height = nextCanvas.height;
      canvas.style.width = `${Math.round(nextViewport.width)}px`;
      canvas.style.height = `${Math.round(nextViewport.height)}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (context) context.drawImage(nextCanvas, 0, 0);

      textLayerContainer.replaceChildren(...Array.from(pendingTextLayer.childNodes));
      textLayerContainer.style.setProperty("--total-scale-factor", String(nextViewport.scale));
      pendingTextLayer.remove();

      highlightLayer.replaceChildren(...Array.from(pendingHighlightLayer.childNodes));
      pendingHighlightLayer.remove();

      renderedViewportRef.current = nextViewport;
      renderedZoomRef.current = zoom;
      stack.dataset.renderedZoom = String(zoom);
      stack.style.width = `${Math.round(nextViewport.width)}px`;
      stack.style.height = `${Math.round(nextViewport.height)}px`;
      applyStackLiveZoom(shell, stack, displayZoomRef.current / zoom);
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
        stack?.classList.remove("is-live-zooming");
        if (stack) stack.style.transform = "";
        if (shell) shell.style.marginBottom = "";
        if (canvas) canvas.width = canvas.height = 0;
        textLayerContainer?.replaceChildren();
        highlightLayer?.replaceChildren();
      }
      if (!cancelled) setRenderState("idle");
    };
  }, [availableWidth, baseViewport, savedPage, shouldRender, zoom]);

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
      );
    };
    draw();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      layer.replaceChildren();
    };
  }, [
    displayZoom,
    highlightRegionKey,
    highlightRegions,
    persistentAnchorKey,
    persistentAnchors,
    renderState,
    savedPage,
    shouldRender,
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
  persistentAnchors,
  highlightRegions,
}: {
  paper: Paper;
  readerRef: RefObject<HTMLElement | null>;
  zoom: number;
  displayZoom: number;
  persistentAnchors: TextAnchor[];
  highlightRegions: HighlightRegion[];
}) {
  const [document, setDocument] = useState<PdfJsDocument>();
  const [error, setError] = useState<string>();
  const [renderWindow, setRenderWindow] = useState({ start: 1, end: 1 });
  const pagesRef = useRef<HTMLDivElement>(null);
  const availableWidth = useReaderWidth(readerRef);
  const renderFrameRef = useRef<number | null>(null);

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
      if (renderFrameRef.current !== null) return;
      renderFrameRef.current = window.requestAnimationFrame(() => {
        renderFrameRef.current = null;
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
  }, [availableWidth, document, paper.id, paper.pages.length, readerRef, updateRenderWindow]);

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
          displayZoom={displayZoom}
          persistentAnchors={persistentAnchors}
          highlightRegions={highlightRegions}
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
  const toolbar = reader?.querySelector<HTMLElement>(".reader-toolbar");
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
  onSelectConversation?: (conversation: Conversation) => void;
  outline: PaperSection[];
  requestedChapterPage?: ChapterScrollRequest;
  conversationFocusRequest?: ConversationFocusRequest;
  onSelectAnchor: (anchor: TextAnchor, additive: boolean) => void;
  onClearSelection: () => void;
  onActiveSectionChange: (sectionId?: string) => void;
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
  onSelectConversation,
  outline,
  requestedChapterPage,
  conversationFocusRequest,
  onSelectAnchor,
  onClearSelection,
  onActiveSectionChange,
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
  const [panMode, setPanMode] = useState(false);
  const [panActive, setPanActive] = useState(false);
  const [hoveredRegionIds, setHoveredRegionIds] = useState<string[]>([]);
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number }>();
  const [pinnedRegionIds, setPinnedRegionIds] = useState<string[]>([]);
  const [pinnedPoint, setPinnedPoint] = useState<{ x: number; y: number }>();
  const [pinFlashNonce, setPinFlashNonce] = useState(0);
  const activeSectionRef = useRef<PaperSection | null>(null);
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
  const pendingZoomRef = useRef<PendingZoomAnchor | null>(null);

  const activeAnchor = activeAnchors[0];

  useEffect(() => {
    try {
      window.localStorage.setItem(READER_ZOOM_KEY, String(zoom));
    } catch {
      // Zoom still works for the current session when localStorage is unavailable.
    }
  }, [zoom]);

  useEffect(() => {
    if (displayZoom === zoom) return;
    const timer = window.setTimeout(() => setZoom(displayZoom), ZOOM_COMMIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [displayZoom, zoom]);

  useLayoutEffect(() => {
    const pending = pendingZoomRef.current;
    if (!pending) return;
    const reader = readerRef.current;
    const stack = reader?.querySelector<HTMLElement>(
      `[data-page="${pending.page}"] .original-page-stack`,
    );
    if (!reader || !stack) return;
    const rect = stack.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    reader.scrollLeft += rect.left + pending.xRatio * rect.width - pending.clientX;
    reader.scrollTop += rect.top + pending.yRatio * rect.height - pending.clientY;
    pendingZoomRef.current = null;
  }, [displayZoom]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const target = event.target;
      const stack = target instanceof HTMLElement
        ? target.closest<HTMLElement>(".original-page-stack") ??
          target.closest<HTMLElement>(".original-page")?.querySelector<HTMLElement>(".original-page-stack") ??
          undefined
        : undefined;
      if (stack) {
        const rect = stack.getBoundingClientRect();
        const pageElement = stack.closest<HTMLElement>("[data-page]");
        if (rect.width && rect.height && pageElement) {
          pendingZoomRef.current = {
            page: Number(pageElement.dataset.page) || 1,
            clientX: event.clientX,
            clientY: event.clientY,
            xRatio: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            yRatio: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
          };
        }
      } else {
        pendingZoomRef.current = null;
      }
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1;
      setDisplayZoom((current) => stepReaderZoom(current, direction));
    };
    reader.addEventListener("wheel", onWheel, { passive: false });
    return () => reader.removeEventListener("wheel", onWheel);
  }, [readerRef]);

  useEffect(() => {
    if (!panMode) return;
    window.getSelection()?.removeAllRanges();
    clearCurrentSelectionHighlights(readerRef.current);
  }, [panMode]);

  useEffect(() => {
    setPageNumber(activeAnchor?.page ?? 1);
    activeSectionRef.current = null;
    onActiveSectionChange(undefined);
  }, [activeAnchor?.page, onActiveSectionChange, paper.id]);

  useEffect(() => {
    if (!activeAnchor?.page) return;
    const element = readerRef.current?.querySelector<HTMLElement>(`[data-page="${activeAnchor.page}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeAnchor?.page, paper.id]);

  useEffect(() => {
    if (!requestedChapterPage) return;
    const element = readerRef.current?.querySelector<HTMLElement>(
      `[data-page="${requestedChapterPage.page}"]`,
    );
    if (!element) return;
    setPageNumber(requestedChapterPage.page);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.remove("section-flash");
    void element.offsetWidth;
    element.classList.add("section-flash");
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === "section-flash") {
        element.classList.remove("section-flash");
      }
    };
    const removeFlash = () => element.classList.remove("section-flash");
    element.addEventListener("animationend", onAnimationEnd);
    const timer = window.setTimeout(removeFlash, 2100);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("animationend", onAnimationEnd);
      element.classList.remove("section-flash");
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
    const section = sectionForPage(outline, page);
    if (section?.id === activeSectionRef.current?.id) return;
    activeSectionRef.current = section ?? null;
    onActiveSectionChange(section?.id);
  }

  function goToPage(page: number) {
    if (page < 1 || page > paper.pageCount) return;
    setPageNumber(page);
    syncSection(page);
    readerRef.current
      ?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleScroll(event?: React.UIEvent<HTMLElement>) {
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
    closeHighlightPopover();
    const clamped = clampReaderZoom(nextZoom);
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
        activeSectionRef.current?.title,
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
      <div className="reader-toolbar">
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
            aria-label="缩小"
            title="缩小"
            disabled={displayZoom <= 0.5}
            onClick={() => changeZoom(stepReaderZoom(displayZoom, -1))}
          >
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            className="zoom-value"
            aria-label={`缩放 ${Math.round(displayZoom * 100)}%，点击重置`}
            title="重置为 100%"
            onClick={() => changeZoom(1)}
          >
            {Math.round(displayZoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            title="放大"
            disabled={displayZoom >= 3}
            onClick={() => changeZoom(stepReaderZoom(displayZoom, 1))}
          >
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
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
        <span className="selection-tip"><MousePointer2 size={14} /> 划选提问 · Ctrl/Cmd 追加</span>
        <div className="reader-restore">
          {leftCollapsed ? (
            <button type="button" onClick={onRestoreLeft}><PanelLeftOpen size={14} /> 展开左侧</button>
          ) : null}
          {rightCollapsed ? (
            <button type="button" onClick={onRestoreRight}><PanelRightOpen size={14} /> 展开右侧</button>
          ) : null}
        </div>
      </div>
      <OriginalPdfView
        paper={paper}
        readerRef={readerRef}
        zoom={zoom}
        displayZoom={displayZoom}
        persistentAnchors={activeAnchors}
        highlightRegions={highlightRegions}
      />
      {pinnedRegionIds.length && pinnedPoint ? (
        <HighlightPopover
          regionIds={pinnedRegionIds}
          regions={highlightRegions}
          conversations={conversations}
          activeConversationId={activeConversationId}
          point={pinnedPoint}
          pinned
          onSelectConversation={onSelectConversation}
        />
      ) : hoveredRegionIds.length && hoverPoint ? (
        <HighlightPopover
          regionIds={hoveredRegionIds}
          regions={highlightRegions}
          conversations={conversations}
          activeConversationId={activeConversationId}
          point={hoverPoint}
          onSelectConversation={onSelectConversation}
        />
      ) : null}
    </section>
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
  onSelectConversation?: (conversation: Conversation) => void;
}

function HighlightPopover({
  regionIds,
  regions,
  conversations,
  activeConversationId,
  point,
  pinned = false,
  onSelectConversation,
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
  const recordsConversation = relatedConversations[0];
  const [position, setPosition] = useState(popoverPosition);
  useEffect(() => {
    setPosition(popoverPosition());
  }, [point]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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
                <button
                  key={item.turn.id}
                  type="button"
                  className={`highlight-popover-index-item ${activeConversationId === conversation.id ? "active" : ""}`}
                  onClick={() => onSelectConversation?.(conversation)}
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
          <div className="highlight-popover-turn-list">
            {recordsConversation.turns.map((turn) => (
              <div key={turn.id} className={`highlight-popover-turn ${turn.role}`}>
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
