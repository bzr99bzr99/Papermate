import { describe, expect, it } from "vitest";
import {
  anchorExcerptParts,
  buildContext,
  buildFullPaperContext,
  buildPaperDigest,
  clampReaderZoom,
  continuousReaderZoom,
  countPageLinks,
  cssMatrixForTextItem,
  defaultHighlightColor,
  deduplicateSections,
  deriveHighlightRegions,
  findSectionHeadingBlock,
  formatAnchorExcerpt,
  flattenPdfOutline,
  HIGHLIGHT_COLORS,
  inferHeadingLevel,
  inferSectionsFromPages,
  latexizeText,
  makeAnchor,
  normalizeLinkRect,
  normalizeSectionHeading,
  normalizeReaderWheelDelta,
  pagesHaveSelectableText,
  paragraphBlocksFromLines,
  resolveOutlineDestinationPage,
  sectionHeadingTopRatio,
  selectionGroupForAnchors,
  stepReaderZoom,
  textLinesFromItems,
} from "./pdf";
import type {
  Conversation,
  HighlightColor,
  PaperSection,
  ParsedPage,
  PdfTextItem,
  SelectionGroup,
  TextAnchor,
} from "./types";

function textItem(
  str: string,
  x: number,
  y: number,
  size = 10,
  options: Partial<PdfTextItem> = {},
): PdfTextItem {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: str.length * size * 0.5,
    height: size,
    hasEOL: false,
    ...options,
  };
}

describe("paper text anchors", () => {
  const blocks = paragraphBlocksFromLines(1, [
    { text: "First paragraph.", top: 700 },
    { text: "It has a second line.", top: 690 },
    { text: "Second paragraph.", top: 650 },
  ]);
  const page: ParsedPage = {
    page: 1,
    text: blocks.map((block) => block.text).join("\n"),
    blocks,
    figures: [],
  };

  it("creates a stable, paragraph-linked anchor", () => {
    const anchor = makeAnchor("paper-1", page, "First paragraph.", 0);
    expect(anchor.id).toMatch(/^paper-1:1:0:/);
    expect(anchor.blockIds).toEqual(["p1-b1"]);
  });

  it("adds neighbouring blocks to the model context", () => {
    const anchor = makeAnchor("paper-1", page, "Second paragraph.", page.text.indexOf("Second"));
    const context = buildContext([page], anchor, 1);
    expect(context).toContain("用户选中内容：Second paragraph.");
    expect(context).toContain("First paragraph.");
  });
});

describe("paragraph block classification", () => {
  it("splits lines into headings, captions, equations and tables", () => {
    const blocks = paragraphBlocksFromLines(1, [
      { text: "Introduction", top: 800, fontSize: 16 },
      { text: "Figure 1: Overview of the proposed method.", top: 700, fontSize: 9 },
      { text: "α + β = γ", top: 600, fontSize: 11 },
      { text: "Method\tAccuracy", top: 500, fontSize: 10 },
      { text: "A\t0.92", top: 480, fontSize: 10 },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "caption", "equation", "table"]);
    expect(blocks[1].label).toBe("Fig. 1");
    expect(blocks[3].cells).toEqual([
      ["Method", "Accuracy"],
      ["A", "0.92"],
    ]);
  });

  it("keeps consecutive body lines in one paragraph", () => {
    const blocks = paragraphBlocksFromLines(1, [
      { text: "We study the problem.", top: 700, fontSize: 11 },
      { text: "A second sentence continues it.", top: 690, fontSize: 11 },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
    expect(blocks[0].text).toBe("We study the problem. A second sentence continues it.");
  });
});

describe("selection excerpt and groups", () => {
  function anchor(id: string, page: number, start: number): TextAnchor {
    return {
      id,
      page,
      start,
      end: start + 6,
      quote: `quote-${page}-${start}`,
      hash: "hash",
    };
  }

  it("keeps short excerpts whole", () => {
    expect(formatAnchorExcerpt("short excerpt")).toBe("short excerpt");
  });

  it("formats long excerpts as beginning ellipsis ending", () => {
    const quote = `start ${"middle ".repeat(30)} end`;
    const excerpt = formatAnchorExcerpt(quote);
    expect(excerpt).toContain("…");
    expect(excerpt.startsWith("start ")).toBe(true);
    expect(excerpt.endsWith(" end")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(58);
  });

  it("normalizes whitespace in excerpts", () => {
    expect(formatAnchorExcerpt("  first \n second\t third  ")).toBe("first second third");
  });

  it("keeps short excerpt parts whole", () => {
    expect(anchorExcerptParts("short excerpt")).toEqual({
      head: "short excerpt",
      tail: "",
      truncated: false,
    });
  });

  it("splits long excerpts into visible head and tail parts", () => {
    const quote = `start ${"middle ".repeat(30)} end`;
    const parts = anchorExcerptParts(quote);
    expect(parts.truncated).toBe(true);
    expect(parts.head).toHaveLength(14);
    expect(parts.tail).toHaveLength(14);
    expect(parts.head.startsWith("start ")).toBe(true);
    expect(parts.tail.endsWith(" end")).toBe(true);
  });

  it("normalizes whitespace in excerpt parts", () => {
    expect(anchorExcerptParts("  first \n second\t third  ")).toEqual({
      head: "first second third",
      tail: "",
      truncated: false,
    });
  });

  it("deduplicates, sorts, and creates a deterministic group id", () => {
    const anchors = [
      anchor("b", 2, 10),
      anchor("a", 1, 20),
      anchor("b", 2, 10),
    ];
    const first = selectionGroupForAnchors("paper-1", anchors);
    const second = selectionGroupForAnchors("paper-1", [anchors[2], anchors[0], anchors[1]]);
    expect(first?.anchors.map((item) => item.id)).toEqual(["a", "b"]);
    expect(second?.id).toBe(first?.id);
  });

  it("returns undefined for an empty fragment group", () => {
    expect(selectionGroupForAnchors("paper-1", [])).toBeUndefined();
  });
});

describe("visual line clustering", () => {
  it("groups a single-column visual line in reading order", () => {
    const lines = textLinesFromItems(
      [
        textItem("Reading", 12, 720),
        textItem("order", 30, 720),
        textItem("second", 12, 705),
        textItem("line", 30, 705),
      ],
      612,
    );

    expect(lines.map((line) => line.text)).toEqual(["Reading order", "second line"]);
    expect(lines.map((line) => line.column)).toEqual([undefined, undefined]);
  });

  it("splits a two-column line by the visible x gap", () => {
    const lines = textLinesFromItems(
      [
        textItem("Left", 14, 720),
        textItem("column", 30, 720),
        textItem("Right", 340, 720),
        textItem("column", 356, 720),
      ],
      612,
    );

    expect(lines.map((line) => line.text)).toEqual(["Left column", "Right column"]);
    expect(lines.map((line) => line.column)).toEqual([0, 1]);
  });

  it("emits complete left and right columns for a two-column page", () => {
    const lines = textLinesFromItems(
      [
        textItem("Left", 14, 720),
        textItem("paragraph", 30, 720),
        textItem("Right", 340, 720),
        textItem("paragraph", 356, 720),
        textItem("Left", 14, 705),
        textItem("continuation", 30, 705),
        textItem("Right", 340, 705),
        textItem("continuation", 356, 705),
      ],
      612,
    );

    expect(lines.map((line) => `${line.column}:${line.text}`)).toEqual([
      "0:Left paragraph",
      "0:Left continuation",
      "1:Right paragraph",
      "1:Right continuation",
    ]);
  });

  it("re-splits a page-level two-column line bridged by formula fragments", () => {
    const lines = textLinesFromItems(
      [
        textItem("Left column first row", 14, 720),
        textItem("Right column first row", 340, 720),
        textItem("Left column second row", 14, 705),
        textItem("Right column second row", 340, 705),
        textItem("Left column third row", 14, 690),
        textItem("Right column third row", 340, 690),
        textItem("feature map", 14, 660),
        textItem("U", 280, 660),
        textItem("∈", 300, 660),
        textItem("Right column bridge row", 311, 660),
      ],
      612,
    );

    expect(lines.map((line) => `${line.column}:${line.text}`)).toEqual([
      "0:Left column first row",
      "0:Left column second row",
      "0:Left column third row",
      "0:feature map",
      "0:U ∈",
      "1:Right column first row",
      "1:Right column second row",
      "1:Right column third row",
      "1:Right column bridge row",
    ]);
  });

  it("propagates an end-of-line marker and keeps y-descending page order", () => {
    const lines = textLinesFromItems(
      [
        textItem("First", 12, 705, 10, { hasEOL: true }),
        textItem("Second", 12, 720),
      ],
      612,
    );

    expect(lines.map((line) => line.text)).toEqual(["Second", "First"]);
    expect(lines[1].hasEOL).toBe(true);
  });
});

describe("paragraph segmentation", () => {
  it("uses EOL markers, column changes, and large vertical gaps as boundaries", () => {
    const blocks = paragraphBlocksFromLines(2, [
      { text: "Left paragraph.", top: 800, column: 0, hasEOL: true },
      { text: "Left continued.", top: 790, column: 0, hasEOL: true },
      { text: "Right paragraph.", top: 800, column: 1 },
      { text: "After a big gap.", top: 740 },
    ]);

    expect(blocks.map((block) => block.text)).toEqual([
      "Left paragraph.",
      "Left continued.",
      "Right paragraph.",
      "After a big gap.",
    ]);
  });

  it("keeps consecutive lines in one paragraph without a hard break", () => {
    const blocks = paragraphBlocksFromLines(3, [
      { text: "A visual line wraps", top: 710, column: 0, hasEOL: false },
      { text: "to the next row.", top: 699, column: 0, hasEOL: false },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("A visual line wraps to the next row.");
  });

  it("splits a large title line from a smaller author line", () => {
    const blocks = paragraphBlocksFromLines(1, [
      { text: "A Study of Models", top: 800, fontSize: 18, hasEOL: false },
      { text: "John Smith", top: 790, fontSize: 10, hasEOL: false },
    ]);

    expect(blocks.map((block) => block.text)).toEqual([
      "A Study of Models",
      "John Smith",
    ]);
  });
});

describe("outline destination parsing", () => {
  async function pageIndex({ num }: { num: number; gen: number }) {
    if (num < 1) throw new Error("invalid reference");
    return num - 1;
  }

  it("resolves explicit destination references and clamps them to the document", async () => {
    expect(
      await resolveOutlineDestinationPage([{ num: 4, gen: 0 }, null, null], 10, pageIndex),
    ).toBe(4);
    expect(
      await resolveOutlineDestinationPage([{ num: 20, gen: 0 }, null, null], 6, pageIndex),
    ).toBe(6);
  });

  it("returns no target for malformed or unresolved destinations", async () => {
    expect(await resolveOutlineDestinationPage(null, 10, pageIndex)).toBe(0);
    expect(await resolveOutlineDestinationPage([], 10, pageIndex)).toBe(0);
    expect(
      await resolveOutlineDestinationPage([{ num: 0, gen: 0 }, null, null], 10, pageIndex),
    ).toBe(0);
  });

  it("flattens string targets, direct targets, and inherited child targets", async () => {
    const resolveDestination = async (name: string) =>
      name === "intro" ? [{ num: 2, gen: 0 }, null, null] : null;
    const sections = await flattenPdfOutline(
      [
        {
          title: "Introduction",
          dest: "intro",
          items: [{ title: "Motivation", dest: null }],
        },
        { title: "Method", dest: [{ num: 5, gen: 0 }, null, null] },
      ],
      12,
      resolveDestination,
      pageIndex,
    );

    expect(
      sections.map(({ title, page, level, source }) => ({ title, page, level, source })),
    ).toEqual([
      { title: "Introduction", page: 2, level: 1, source: "outline" },
      { title: "Motivation", page: 2, level: 2, source: "outline" },
      { title: "Method", page: 5, level: 1, source: "outline" },
    ]);
  });
});

describe("section metadata", () => {
  it("infers hierarchy from numbering and font size", () => {
    expect(inferHeadingLevel("2.3.1 Experimental setup", 11)).toBe(3);
    expect(inferHeadingLevel("Introduction", 11)).toBe(1);
    expect(inferHeadingLevel("Model architecture", 18)).toBe(1);
    expect(inferHeadingLevel("Model architecture", 14)).toBe(2);
    expect(inferHeadingLevel("Model architecture", 11)).toBe(3);
    expect(inferHeadingLevel("III. Methodology", 12)).toBe(1);
    expect(inferHeadingLevel("A. Datasets", 12)).toBe(2);
    expect(inferHeadingLevel("V. Conclusion", 12)).toBe(1);
    expect(inferHeadingLevel("C. Adaptive Multi-Wavelet Convolution", 12)).toBe(2);
    expect(inferHeadingLevel("D. Ablation Study", 12)).toBe(2);
  });

  it("merges fragmented uppercase headings and canonicalizes common names", () => {
    const page: ParsedPage = {
      page: 2,
      text: "II. RELATED WORK",
      blocks: [
        {
          id: "p2-b1",
          page: 2,
          index: 0,
          text: "II.",
          start: 0,
          end: 3,
          top: 700,
          kind: "heading",
          fontSize: 14,
        },
        {
          id: "p2-b2",
          page: 2,
          index: 1,
          text: "RELATED",
          start: 4,
          end: 11,
          top: 690,
          kind: "heading",
          fontSize: 14,
        },
        {
          id: "p2-b3",
          page: 2,
          index: 2,
          text: "WORK",
          start: 12,
          end: 16,
          top: 680,
          kind: "heading",
          fontSize: 14,
        },
      ],
      figures: [],
    };

    expect(inferSectionsFromPages([page]).map((section) => section.title)).toEqual([
      "II. Related Work",
    ]);
  });

  it("skips the unnumbered paper title at the top of the first page", () => {
    const page: ParsedPage = {
      page: 1,
      text: "Reading Multi-Modal Papers",
      height: 792,
      blocks: [
        {
          id: "p1-b1",
          page: 1,
          index: 0,
          text: "Reading Multi-Modal Papers",
          start: 0,
          end: 26,
          top: 760,
          kind: "heading",
          fontSize: 18,
        },
        {
          id: "p1-b2",
          page: 1,
          index: 1,
          text: "Introduction",
          start: 27,
          end: 39,
          top: 700,
          kind: "heading",
          fontSize: 14,
        },
      ],
      figures: [],
    };

    expect(inferSectionsFromPages([page]).map((section) => section.title)).toEqual([
      "Introduction",
    ]);
  });

  it("rejects body sentences, compact abbreviation lists, and numeric rows as sections", () => {
    const page: ParsedPage = {
      page: 3,
      text: "The proposed method achieves high accuracy. Q, K, V 0.92 1.10",
      blocks: [
        {
          id: "p3-b1",
          page: 3,
          index: 0,
          text: "The proposed method achieves high accuracy.",
          start: 0,
          end: 43,
          top: 700,
          kind: "heading",
          fontSize: 16,
        },
        {
          id: "p3-b2",
          page: 3,
          index: 1,
          text: "Q, K, V",
          start: 44,
          end: 51,
          top: 680,
          kind: "heading",
          fontSize: 13,
        },
        {
          id: "p3-b3",
          page: 3,
          index: 2,
          text: "0.92 1.10",
          start: 52,
          end: 61,
          top: 660,
          kind: "heading",
          fontSize: 13,
        },
      ],
      figures: [],
    };

    expect(inferSectionsFromPages([page])).toEqual([]);
  });

  it("canonicalizes spaced uppercase sections without adding reference rows", () => {
    const page: ParsedPage = {
      page: 4,
      text: "A CKNOWLEDGMENT R EFERENCES A. AlShorman, review",
      blocks: [
        {
          id: "p4-b1",
          page: 4,
          index: 0,
          text: "A CKNOWLEDGMENT",
          start: 0,
          end: 14,
          top: 700,
          kind: "heading",
          fontSize: 10,
        },
        {
          id: "p4-b2",
          page: 4,
          index: 1,
          text: "R EFERENCES",
          start: 15,
          end: 26,
          top: 620,
          kind: "heading",
          fontSize: 10,
        },
        {
          id: "p4-b3",
          page: 4,
          index: 2,
          text: "A. AlShorman, “A review of artificial intelligence methods”",
          start: 27,
          end: 88,
          top: 580,
          kind: "heading",
          fontSize: 16,
        },
      ],
      figures: [],
    };

    expect(inferSectionsFromPages([page]).map((section) => section.title)).toEqual([
      "Acknowledgment",
      "References",
    ]);
  });

  it("filters abbreviation fragments, inline formula rows, and table headers", () => {
    const page: ParsedPage = {
      page: 5,
      text: "KW-STB) JL-CNN MBSCNN 1 p =1 Method Params (M)",
      blocks: [
        {
          id: "p5-b1",
          page: 5,
          index: 0,
          text: "KW-STB)",
          start: 0,
          end: 7,
          top: 700,
          kind: "heading",
          fontSize: 13,
        },
        {
          id: "p5-b2",
          page: 5,
          index: 1,
          text: "JL-CNN",
          start: 8,
          end: 14,
          top: 680,
          kind: "heading",
          fontSize: 13,
        },
        {
          id: "p5-b3",
          page: 5,
          index: 2,
          text: "MBSCNN",
          start: 15,
          end: 21,
          top: 660,
          kind: "heading",
          fontSize: 13,
        },
        {
          id: "p5-b4",
          page: 5,
          index: 3,
          text: "1 p =1",
          start: 22,
          end: 28,
          top: 640,
          kind: "heading",
          fontSize: 16,
        },
        {
          id: "p5-b5",
          page: 5,
          index: 4,
          text: "TABLE IV: Parameter counts of different methods.",
          start: 29,
          end: 78,
          top: 520,
          kind: "paragraph",
          fontSize: 10,
        },
        {
          id: "p5-b6",
          page: 5,
          index: 5,
          text: "Method",
          start: 79,
          end: 85,
          top: 480,
          kind: "heading",
          fontSize: 8,
        },
        {
          id: "p5-b7",
          page: 5,
          index: 6,
          text: "Params (M)",
          start: 86,
          end: 96,
          top: 480,
          kind: "paragraph",
          fontSize: 8,
        },
      ],
      figures: [],
    };

    expect(inferSectionsFromPages([page])).toEqual([]);
  });

  it("removes blank titles and page/level/title duplicates", () => {
    const sections: PaperSection[] = [
      { id: "d", title: "References", page: 7, level: 1, source: "inferred" },
      { id: "b", title: "Introduction", page: 2, level: 1, source: "inferred" },
      { id: "c", title: "Method", page: 5, level: 1, source: "inferred" },
      { id: "e", title: "", page: 7, level: 2, source: "inferred" },
    ];

    expect(deduplicateSections(sections).map((section) => section.title)).toEqual([
      "Introduction",
      "Method",
      "References",
    ]);
  });
});

describe("multi-fragment model context", () => {
  const firstBlocks = paragraphBlocksFromLines(1, [
    { text: "First selected sentence.", top: 700 },
    { text: "Neighbouring first page context.", top: 690 },
  ]);
  const secondBlocks = paragraphBlocksFromLines(2, [
    { text: "Second selected sentence.", top: 700 },
    { text: "Neighbouring second page context.", top: 690 },
  ]);
  const pages: ParsedPage[] = [
    {
      page: 1,
      text: firstBlocks.map((block) => block.text).join("\n"),
      blocks: firstBlocks,
      figures: [],
    },
    {
      page: 2,
      text: secondBlocks.map((block) => block.text).join("\n"),
      blocks: secondBlocks,
      figures: [],
    },
  ];
  const anchors = [
    makeAnchor("paper-1", pages[0], "First selected sentence.", 0),
    makeAnchor("paper-1", pages[1], "Second selected sentence.", 0),
  ];

  it("keeps the legacy single-anchor context format", () => {
    const context = buildContext(pages, anchors[0]);
    expect(context).toContain("原文定位：第 1 页");
    expect(context).toContain("用户选中内容：First selected sentence.");
    expect(context).toContain("相邻上下文：");
  });

  it("numbers every fragment and includes page context for each", () => {
    const context = buildContext(pages, anchors);
    expect(context).toContain("原文定位：第 1、2 页，共 2 个选中片段");
    expect(context).toContain("[片段 1，第 1 页] First selected sentence.");
    expect(context).toContain("[片段 2，第 2 页] Second selected sentence.");
    expect(context).toContain("Neighbouring first page context.");
    expect(context).toContain("Neighbouring second page context.");
  });
});

describe("full-paper context digest", () => {
  const page1Blocks = paragraphBlocksFromLines(1, [
    { text: "Abstract", top: 800, fontSize: 16 },
    { text: "Abstract body with the core contribution.", top: 780 },
    { text: "Introduction", top: 760, fontSize: 16 },
    { text: "Introduction body about the motivation.", top: 740 },
  ]);
  const page2Blocks = paragraphBlocksFromLines(2, [
    { text: "Method", top: 800, fontSize: 16 },
    { text: "Method body with the proposed algorithm.", top: 780 },
  ]);
  const page3Blocks = paragraphBlocksFromLines(3, [
    { text: "Conclusion", top: 800, fontSize: 16 },
    { text: "Conclusion body with the main findings.", top: 780 },
  ]);
  const pages: ParsedPage[] = [
    {
      page: 1,
      text: page1Blocks.map((block) => block.text).join("\n"),
      blocks: page1Blocks,
      figures: [],
    },
    {
      page: 2,
      text: page2Blocks.map((block) => block.text).join("\n"),
      blocks: page2Blocks,
      figures: [],
    },
    {
      page: 3,
      text: page3Blocks.map((block) => block.text).join("\n"),
      blocks: page3Blocks,
      figures: [],
    },
  ];
  const outline: PaperSection[] = [
    { id: "s1", title: "Abstract", page: 1, level: 1, source: "inferred" },
    { id: "s2", title: "Introduction", page: 1, level: 1, source: "inferred" },
    { id: "s3", title: "Method", page: 2, level: 1, source: "inferred" },
    { id: "s4", title: "Conclusion", page: 3, level: 1, source: "inferred" },
  ];

  it("builds a structured digest with title, outline and section excerpts", () => {
    const digest = buildPaperDigest(pages, outline, "Test Paper", 2000);
    expect(digest).toContain("论文标题：Test Paper");
    expect(digest).toContain("全文结构：");
    expect(digest).toContain("Abstract body with the core contribution.");
    expect(digest).toContain("Introduction body about the motivation.");
    expect(digest).toContain("Method body with the proposed algorithm.");
    expect(digest).toContain("Conclusion body with the main findings.");
  });

  it("caps the digest at the requested character limit", () => {
    const digest = buildPaperDigest(pages, outline, "Test Paper", 250);
    expect(digest.length).toBeLessThanOrEqual(250);
  });

  it("falls back to inferred sections when no outline is available", () => {
    const digest = buildPaperDigest(pages, [], "Test Paper", 2000);
    expect(digest).toContain("Abstract body with the core contribution.");
    expect(digest).toContain("Method body with the proposed algorithm.");
  });

  it("always keeps the selected quote inside the full context", () => {
    const anchor = makeAnchor(
      "paper-1",
      pages[2],
      "Conclusion body with the main findings.",
      pages[2].text.indexOf("Conclusion body with the main findings."),
    );
    const full = buildFullPaperContext(pages, anchor, outline, "Test Paper", 2000);
    expect(full).toContain("用户选中内容：Conclusion body with the main findings.");
    expect(full).toContain("Abstract body with the core contribution.");
    expect(full.length).toBeLessThanOrEqual(2000);
  });
});

describe("reader zoom", () => {
  it("clamps invalid, low, and high zoom values", () => {
    expect(clampReaderZoom(Number.NaN)).toBe(1);
    expect(clampReaderZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampReaderZoom(0.2)).toBe(0.5);
    expect(clampReaderZoom(5)).toBe(3);
  });

  it("steps in tenths and does not pass the range bounds", () => {
    expect(stepReaderZoom(1, 1)).toBe(1.1);
    expect(stepReaderZoom(1, -1)).toBe(0.9);
    expect(stepReaderZoom(0.5, -1)).toBe(0.5);
    expect(stepReaderZoom(3, 1)).toBe(3);
  });

  it("normalizes wheel deltas from pixel, line, and page modes", () => {
    expect(normalizeReaderWheelDelta(-120, 0)).toBe(-120);
    expect(normalizeReaderWheelDelta(-3, 1)).toBe(-48);
    expect(normalizeReaderWheelDelta(-1, 2, 900)).toBe(-900);
    expect(normalizeReaderWheelDelta(Number.NaN, 0)).toBe(0);
  });

  it("applies continuous exponential zoom with bounds", () => {
    expect(continuousReaderZoom(1, -120)).toBeCloseTo(Math.exp(0.144), 6);
    expect(continuousReaderZoom(1, 120)).toBeCloseTo(Math.exp(-0.144), 6);
    expect(continuousReaderZoom(0.5, 10_000)).toBe(0.5);
    expect(continuousReaderZoom(3, -10_000)).toBe(3);
    expect(continuousReaderZoom(Number.NaN, -120)).toBe(1);
  });
});

describe("anchor metadata", () => {
  const page: ParsedPage = {
    page: 4,
    text: "alpha beta gamma",
    blocks: [
      {
        id: "p4-b1",
        page: 4,
        index: 0,
        text: "alpha beta gamma",
        start: 0,
        end: 16,
        top: 700,
      },
    ],
    figures: [],
  };

  it("keeps text layer boundaries and maps block ids", () => {
    const anchor = makeAnchor("paper-1", page, "alpha beta", 0, "Methods", {
      blockIds: ["p4-b1"],
      textItemStart: 2,
      textItemEnd: 4,
      textStartOffset: 1,
      textEndOffset: 7,
    });
    expect(anchor.textItemStart).toBe(2);
    expect(anchor.textItemEnd).toBe(4);
    expect(anchor.textStartOffset).toBe(1);
    expect(anchor.textEndOffset).toBe(7);
    expect(anchor.blockIds).toEqual(["p4-b1"]);
    expect(anchor.section).toBe("Methods");
  });

  it("normalizes quote whitespace while preserving the old signature", () => {
    const anchor = makeAnchor("paper-1", page, "  alpha\t beta  ", 0);
    expect(anchor.quote).toBe("alpha beta");
    expect(anchor.blockIds).toEqual(["p4-b1"]);
    expect(anchor.textItemStart).toBeUndefined();
  });
});

describe("highlight region derivation", () => {
  const anchorA: TextAnchor = {
    id: "paper-1:1:0:a",
    page: 1,
    start: 0,
    end: 8,
    quote: "alpha",
    hash: "a",
  };
  const anchorB: TextAnchor = {
    id: "paper-1:1:12:b",
    page: 1,
    start: 12,
    end: 20,
    quote: "beta",
    hash: "b",
  };

  function conversation(options: {
    id: string;
    anchor?: TextAnchor;
    selection?: SelectionGroup;
    scope?: "normal" | "context";
    color?: HighlightColor;
    updatedAt?: string;
    userQuestion?: string;
  }): Conversation {
    const updatedAt = options.updatedAt ?? "2026-01-01T00:00:00.000Z";
    return {
      id: options.id,
      paperId: "paper-1",
      anchor: options.anchor,
      selection: options.selection,
      scope: options.scope,
      title: "测试问答",
      color: options.color,
      turns: options.userQuestion
        ? [
            {
              id: `${options.id}-user`,
              role: "user",
              content: options.userQuestion,
              createdAt: updatedAt,
            },
            {
              id: `${options.id}-assistant`,
              role: "assistant",
              content: "回答内容",
              createdAt: updatedAt,
            },
          ]
        : [],
      updatedAt,
    };
  }

  it("merges conversations that share the same anchor", () => {
    const regions = deriveHighlightRegions([
      conversation({
        id: "c1",
        anchor: anchorA,
        color: "sage",
        updatedAt: "2026-01-01T00:00:00.000Z",
        userQuestion: "第一问",
      }),
      conversation({
        id: "c2",
        anchor: anchorA,
        color: "rose",
        updatedAt: "2026-01-02T00:00:00.000Z",
        userQuestion: "第二问",
      }),
    ]);

    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe(`region:${anchorA.id}`);
    expect(regions[0].conversationIds).toEqual(["c1", "c2"]);
    expect(regions[0].color).toBe("rose");
    expect(regions[0].updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("assigns default palette colors to legacy conversations without color", () => {
    const regions = deriveHighlightRegions([
      conversation({
        id: "c1",
        anchor: anchorA,
        updatedAt: "2026-01-01T00:00:00.000Z",
        userQuestion: "第一问",
      }),
      conversation({
        id: "c2",
        anchor: anchorB,
        updatedAt: "2026-01-02T00:00:00.000Z",
        userQuestion: "第二问",
      }),
    ]);

    expect(regions.map((region) => region.anchor.id)).toEqual([
      anchorB.id,
      anchorA.id,
    ]);
    expect(regions[0].color).toBe(defaultHighlightColor(1));
    expect(regions[1].color).toBe(defaultHighlightColor(0));
    expect(HIGHLIGHT_COLORS).toHaveLength(new Set(HIGHLIGHT_COLORS).size);
  });

  it("does not generate a region for full-paper questions without an anchor", () => {
    const regions = deriveHighlightRegions([
      conversation({ id: "c1", userQuestion: "总结全文" }),
    ]);
    expect(regions).toEqual([]);
  });

  it("creates one region per anchor in a multi-fragment selection", () => {
    const selection: SelectionGroup = {
      id: "paper-1:group:abc",
      paperId: "paper-1",
      anchors: [anchorA, anchorB],
    };
    const regions = deriveHighlightRegions([
      conversation({ id: "c1", selection, userQuestion: "比较两段" }),
    ]);

    expect(regions.map((region) => region.anchor.id).sort()).toEqual(
      [anchorA.id, anchorB.id].sort(),
    );
    expect(regions.every((region) => region.conversationIds.includes("c1"))).toBe(
      true,
    );
  });

  it("keeps context conversations in the same highlight region", () => {
    const regions = deriveHighlightRegions([
      conversation({
        id: "c1",
        anchor: anchorA,
        scope: "normal",
        userQuestion: "普通提问",
      }),
      conversation({
        id: "c2",
        anchor: anchorA,
        scope: "context",
        userQuestion: "全文上下文提问",
      }),
    ]);

    expect(regions).toHaveLength(1);
    expect(regions[0].conversationIds.sort()).toEqual(["c1", "c2"]);
  });

  it("ignores conversations without a user question", () => {
    const regions = deriveHighlightRegions([
      conversation({ id: "c1", anchor: anchorA }),
    ]);
    expect(regions).toEqual([]);
  });
});

describe("text layer matrix mapping", () => {
  it("maps PDF coordinates to the CSS viewport y axis", () => {
    const item = textItem("x", 100, 200, 12);
    expect(cssMatrixForTextItem(item, [1, 0, 0, -1, 0, 792])).toBe(
      "matrix(12.0000,0.0000,0.0000,-12.0000,100.0000,592.0000)",
    );
  });
});

describe("latexizeText", () => {
  it("only wraps explicit inline math runs", () => {
    expect(latexizeText("α β ≤ 1")).toBe("α β $\\leq$ 1");
    expect(latexizeText("x² + 1")).toBe("$x^{2}$ + 1");
    expect(latexizeText("α+β=γ")).toBe("$\\alpha+\\beta=\\gamma$");
  });

  it("leaves ordinary Greek words and abbreviations in body text alone", () => {
    expect(latexizeText("Aβ deposition was measured.")).toBe("Aβ deposition was measured.");
    expect(latexizeText("α particles were emitted.")).toBe("α particles were emitted.");
  });

  it("wraps block equations in display math", () => {
    expect(latexizeText("α + β = γ", true)).toBe("$$\\alpha + \\beta = \\gamma$$");
  });
});

describe("pagesHaveSelectableText", () => {
  it("returns true when every page has non-empty text items", () => {
    const pages = [
      { textItems: [textItem("hello", 0, 0), textItem("world", 10, 0)] },
      { textItems: [textItem(" ", 0, 0), textItem("second page", 10, 0)] },
    ];
    expect(pagesHaveSelectableText(pages)).toBe(true);
  });

  it("returns false for empty or missing pages", () => {
    expect(pagesHaveSelectableText(undefined)).toBe(false);
    expect(pagesHaveSelectableText([])).toBe(false);
  });

  it("returns false when a page lacks text items entirely", () => {
    expect(pagesHaveSelectableText([{ textItems: [] }])).toBe(false);
    expect(pagesHaveSelectableText([{ textItems: undefined }])).toBe(false);
  });

  it("returns false when every page has only whitespace items", () => {
    expect(pagesHaveSelectableText([{ textItems: [textItem("   ", 0, 0)] }])).toBe(false);
  });
});

describe("countPageLinks", () => {
  it("counts internal, external and total links", () => {
    const pages = [
      {
        links: [
          { rect: [0, 0, 1, 1] as [number, number, number, number], targetPage: 3, targetTop: 40 },
          { rect: [0, 0, 1, 1] as [number, number, number, number], url: "https://doi.org/x" },
        ],
      },
      { links: [{ rect: [0, 0, 1, 1] as [number, number, number, number], targetPage: 5 }] },
      { links: undefined },
    ];
    expect(countPageLinks(pages)).toEqual({ total: 3, internal: 2, external: 1 });
  });

  it("returns zeros for no links", () => {
    expect(countPageLinks(undefined)).toEqual({ total: 0, internal: 0, external: 0 });
    expect(countPageLinks([{ links: [] }])).toEqual({ total: 0, internal: 0, external: 0 });
  });
});

describe("normalizeLinkRect", () => {
  it("normalizes viewport rects with inverted y order (pdf.js flipped y axis)", () => {
    // convertToViewportRectangle 返回 [x1, y1, x2, y2]，y1 是下边、y2 是上边。
    expect(normalizeLinkRect([71.9, 260.76, 116.81, 253.36])).toEqual([
      71.9, 253.36, 116.81, 260.76,
    ]);
  });

  it("keeps already-ordered rects unchanged", () => {
    expect(normalizeLinkRect([10, 20, 30, 40])).toEqual([10, 20, 30, 40]);
  });

  it("orders left/right as well as top/bottom independently", () => {
    expect(normalizeLinkRect([30, 40, 10, 20])).toEqual([10, 20, 30, 40]);
    expect(normalizeLinkRect([30, 20, 10, 40])).toEqual([10, 20, 30, 40]);
  });
});

describe("section heading positioning helpers", () => {
  const page: ParsedPage = {
    page: 1,
    text: "Introduction\nMethod",
    figures: [],
    height: 800,
    rotation: 0,
    blocks: [
      {
        id: "h1",
        page: 1,
        index: 0,
        text: "Introduction",
        start: 0,
        end: 12,
        top: 720,
        kind: "heading",
      },
      {
        id: "h2",
        page: 1,
        index: 1,
        text: "Method",
        start: 13,
        end: 19,
        top: 520,
        kind: "heading",
      },
    ],
  };

  it("finds each heading on the same page by its own title", () => {
    expect(findSectionHeadingBlock(page, "Introduction")?.id).toBe("h1");
    expect(findSectionHeadingBlock(page, "Method")?.id).toBe("h2");
  });

  it("matches numbered outline titles to unnumbered heading blocks", () => {
    expect(normalizeSectionHeading("1. Introduction")).toBe("introduction");
    expect(findSectionHeadingBlock(page, "1. Introduction")?.text).toBe("Introduction");
    expect(findSectionHeadingBlock(page, "III. Method")?.text).toBe("Method");
  });

  it("returns a top-down ratio for upright and 180-degree pages", () => {
    expect(sectionHeadingTopRatio(page, "Introduction")).toBeCloseTo(0.1);
    expect(sectionHeadingTopRatio(page, "Method")).toBeCloseTo(0.35);
    expect(sectionHeadingTopRatio({ ...page, rotation: 180 }, "Introduction")).toBeCloseTo(0.1);
  });

  it("returns undefined for rotated pages or missing headings", () => {
    expect(sectionHeadingTopRatio({ ...page, rotation: 90 }, "Introduction")).toBeUndefined();
    expect(sectionHeadingTopRatio({ ...page, rotation: 270 }, "Method")).toBeUndefined();
    expect(sectionHeadingTopRatio(page, "Missing")).toBeUndefined();
  });
});
