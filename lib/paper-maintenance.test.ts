import { describe, expect, it } from "vitest";
import {
  BACKFILL_COOLDOWN_MS,
  MAX_BACKFILL_ATTEMPTS,
  countUnresolvedLinks,
  isBackfillDue,
  nextBackfillRecord,
  planPaperMaintenance,
  type MaintenanceInput,
} from "./paper-maintenance";
import type { PdfLinkAnnotation, PdfTextItem, ParsedPage } from "./types";

const NOW = new Date("2026-09-14T12:00:00.000Z");

type PageSlice = Pick<ParsedPage, "links" | "textItems">;

const textItem = (str: string): PdfTextItem => ({
  str,
  transform: [1, 0, 0, 1, 0, 0],
  width: 20,
  height: 10,
  hasEOL: false,
});

const link = (targetPage?: number, targetTop?: number): PdfLinkAnnotation => ({
  rect: [0, 0, 10, 10],
  targetPage,
  targetTop,
});

const urlLink = (url: string): PdfLinkAnnotation => ({ rect: [0, 0, 10, 10], url });

function page(overrides: Partial<PageSlice> = {}): PageSlice {
  return { textItems: [textItem("hello")], ...overrides };
}

function input(overrides: Partial<MaintenanceInput> = {}): MaintenanceInput {
  return {
    title: "A Universal Framework for Testing",
    fileName: "framework.pdf",
    impactFactor: "6.16",
    pages: [page({ links: [] })],
    originalReady: true,
    ...overrides,
  };
}

describe("planPaperMaintenance", () => {
  it("数据齐全时什么都不做（不重解析、不重查）", () => {
    const plan = planPaperMaintenance(input(), NOW);
    expect(plan.layout).toEqual({ reason: "none", needed: false, due: false });
    expect(plan.metadata.reason).toBe("none");
    expect(plan.metadata.needed).toBe(false);
    expect(plan.metadata.due).toBe(false);
  });

  it("所有页都没有 links 字段（老数据）→ 需要补一次；补完（links: []）后不再需要", () => {
    const legacy = planPaperMaintenance(input({ pages: [page()] }), NOW);
    expect(legacy.layout.reason).toBe("links-missing");
    expect(legacy.layout.due).toBe(true);

    const scanned = planPaperMaintenance(
      input({
        pages: [page({ links: [] })],
        linksCheckedAt: NOW.toISOString(),
        linksAttempts: 0,
      }),
      NOW,
    );
    expect(scanned.layout.needed).toBe(false);
    expect(scanned.layout.due).toBe(false);
  });

  it("本来就没有链接注解的 PDF（links: []）不会被当成缺 links", () => {
    const plan = planPaperMaintenance(
      input({ pages: [page({ links: [] }), page({ links: [] })] }),
      NOW,
    );
    expect(plan.layout.reason).toBe("none");
  });

  it("内部链接缺 targetTop → 需要补；冷却期内不再重试，冷却过后再试", () => {
    const stale = [link(3)];
    const first = planPaperMaintenance(input({ pages: [page({ links: stale })] }), NOW);
    expect(first.layout.reason).toBe("links-stale");
    expect(first.layout.due).toBe(true);

    const recent = planPaperMaintenance(
      input({
        pages: [page({ links: stale })],
        linksCheckedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        linksAttempts: 1,
      }),
      NOW,
    );
    expect(recent.layout.needed).toBe(true);
    expect(recent.layout.due).toBe(false);

    const later = planPaperMaintenance(
      input({
        pages: [page({ links: stale })],
        linksCheckedAt: new Date(NOW.getTime() - BACKFILL_COOLDOWN_MS - 1000).toISOString(),
        linksAttempts: 1,
      }),
      NOW,
    );
    expect(later.layout.due).toBe(true);
  });

  it("连续失败到上限后不再自动重试", () => {
    const plan = planPaperMaintenance(
      input({
        pages: [page({ links: [link(3)] })],
        linksCheckedAt: new Date(NOW.getTime() - BACKFILL_COOLDOWN_MS * 10).toISOString(),
        linksAttempts: MAX_BACKFILL_ATTEMPTS,
      }),
      NOW,
    );
    expect(plan.layout.needed).toBe(true);
    expect(plan.layout.due).toBe(false);
  });

  it("originalReady 缺失 / 缺文本项 → 需要补排版数据", () => {
    expect(
      planPaperMaintenance(input({ originalReady: undefined }), NOW).layout.reason,
    ).toBe("original-missing");
    expect(
      planPaperMaintenance(input({ pages: [{ textItems: [], links: [] }] }), NOW).layout.reason,
    ).toBe("text-missing");
  });

  it("有外部链接的页不算缺 links", () => {
    const plan = planPaperMaintenance(
      input({ pages: [page({ links: [urlLink("https://example.com")] })] }),
      NOW,
    );
    expect(plan.layout.reason).toBe("none");
  });

  it("缺影响因子 → 到点会查元数据，但受冷却限制", () => {
    const first = planPaperMaintenance(input({ impactFactor: undefined }), NOW);
    expect(first.metadata.reason).toBe("impact-factor-missing");
    expect(first.metadata.due).toBe(true);

    const withinCooldown = planPaperMaintenance(
      input({
        impactFactor: undefined,
        metadataCheckedAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
        metadataAttempts: 1,
      }),
      NOW,
    );
    expect(withinCooldown.metadata.needed).toBe(true);
    expect(withinCooldown.metadata.due).toBe(false);
  });

  it("标题像文件名或太弱 → 需要重查标题", () => {
    const byFileName = planPaperMaintenance(
      input({ title: "framework", fileName: "framework.pdf" }),
      NOW,
    );
    expect(byFileName.metadata.reason).toBe("weak-title");
    expect(byFileName.metadata.titleNeedsLookup).toBe(true);

    const weak = planPaperMaintenance(input({ title: "untitled" }), NOW);
    expect(weak.metadata.reason).toBe("weak-title");
  });

  it("缺关键词不算触发条件（避免为它反复联网）", () => {
    const plan = planPaperMaintenance(input({ impactFactor: "12.4" }), NOW);
    expect(plan.metadata.needed).toBe(false);
  });

  it("排版数据与元数据互不影响", () => {
    const onlyLayout = planPaperMaintenance(
      input({ impactFactor: "12.4", pages: [page()] }),
      NOW,
    );
    expect(onlyLayout.layout.due).toBe(true);
    expect(onlyLayout.metadata.due).toBe(false);

    const onlyMetadata = planPaperMaintenance(
      input({ impactFactor: undefined, pages: [page({ links: [] })] }),
      NOW,
    );
    expect(onlyMetadata.layout.due).toBe(false);
    expect(onlyMetadata.metadata.due).toBe(true);
  });
});

describe("countUnresolvedLinks", () => {
  it("只数知道目标页但缺坐标的内部链接", () => {
    expect(
      countUnresolvedLinks([
        { links: [link(3), link(4, 12), urlLink("https://x")] },
        { links: [link(7)] },
        { links: [] },
      ]),
    ).toBe(2);
    expect(countUnresolvedLinks(undefined)).toBe(0);
  });
});

describe("nextBackfillRecord", () => {
  it("成功清零，失败累加，两种情况都刷新尝试时间", () => {
    const first = nextBackfillRecord(undefined, false, NOW);
    expect(first).toEqual({ checkedAt: NOW.toISOString(), attempts: 1 });

    const second = nextBackfillRecord(first, false, NOW);
    expect(second.attempts).toBe(2);

    const recovered = nextBackfillRecord(second, true, NOW);
    expect(recovered.attempts).toBe(0);
  });
});

describe("isBackfillDue", () => {
  it("没记录 → 到期；时间无法解析 → 到期", () => {
    expect(isBackfillDue(undefined, NOW)).toBe(true);
    expect(isBackfillDue({ checkedAt: "not-a-date", attempts: 1 }, NOW)).toBe(true);
  });
});
