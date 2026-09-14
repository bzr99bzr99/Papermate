import { pagesHaveSelectableText } from "./pdf";
import { isWeakPaperTitle } from "./paper-metadata";
import type { ParsedPage } from "./types";

/**
 * 「打开论文时要不要补齐」的判定与重试策略。
 *
 * 背景：以前每次打开论文都按固定条件判断要不要重解析 PDF / 重查期刊元数据，
 * 其中两条条件对某些论文**永远成立**，于是每次打开都白跑一遍：
 *
 *   1. 「所有页都没有 links 字段」——本来就没有链接注解的 PDF，解析结果里
 *      `links` 是 undefined（`buildPageLinks` 的旧契约），落盘时被 JSON 丢掉，
 *      下次打开条件依然成立 → 每次打开都把整本 PDF 重新解析一遍。
 *   2. 「内部链接缺 targetTop」——目标坐标解析不出来的链接，重试多少次都补不上，
 *      于是每次打开都重试。
 *
 * 现在两头都收住：
 *   * 解析器把"确实没有链接"表达成 `links: []`（与"没能确定"的 undefined 区分开），
 *     所以扫过一遍就不再重扫；
 *   * 每篇论文记一份「补齐台账」（上次尝试时间 + 连续失败次数），失败后按冷却时间
 *     重试、超过上限就不再自动重试；成功后清零。
 */

/** 补不上时的重试冷却：同一种补齐最多一天再试一次。 */
export const BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 自动重试次数上限：连续失败这么多次后不再自动重试（用户手动触发不受限）。 */
export const MAX_BACKFILL_ATTEMPTS = 5;

export interface BackfillRecord {
  checkedAt?: string;
  attempts?: number;
}

export type LayoutRepairReason =
  | "original-missing"
  | "links-missing"
  | "links-stale"
  | "text-missing"
  | "none";

export type MetadataLookupReason =
  | "weak-title"
  | "impact-factor-missing"
  | "none";

export interface MaintenanceInput {
  title: string;
  fileName: string;
  impactFactor?: string;
  pages: Array<Pick<ParsedPage, "links" | "textItems">>;
  originalReady?: boolean;
  linksCheckedAt?: string;
  linksAttempts?: number;
  metadataCheckedAt?: string;
  metadataAttempts?: number;
}

export interface MaintenancePlan {
  /** 排版数据（links/textItems）补齐计划。 */
  layout: { reason: LayoutRepairReason; needed: boolean; due: boolean };
  /** 元数据（标题/期刊/影响因子/关键词）查询计划。 */
  metadata: {
    reason: MetadataLookupReason;
    needed: boolean;
    due: boolean;
    titleNeedsLookup: boolean;
  };
}

/** 台账是否到点：从没试过、冷却已过、且没超过次数上限。 */
export function isBackfillDue(
  record: BackfillRecord | undefined,
  now: Date = new Date(),
  cooldownMs: number = BACKFILL_COOLDOWN_MS,
): boolean {
  const attempts = record?.attempts ?? 0;
  if (attempts >= MAX_BACKFILL_ATTEMPTS) return false;
  const checkedAt = record?.checkedAt;
  if (!checkedAt) return true;
  const last = Date.parse(checkedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= cooldownMs;
}

/** 内部链接里"知道目标页但不知道页码内位置"的条数。 */
export function countUnresolvedLinks(
  pages: Array<Pick<ParsedPage, "links">> | undefined,
): number {
  return (pages ?? []).reduce(
    (total, page) =>
      total +
      (page.links ?? []).filter(
        (link) => link.targetPage !== undefined && link.targetTop === undefined,
      ).length,
    0,
  );
}

export function planPaperMaintenance(
  input: MaintenanceInput,
  now: Date = new Date(),
): MaintenancePlan {
  const pages = input.pages ?? [];
  const fileNameBase = input.fileName.replace(/\.pdf$/i, "");
  const titleIsFileName =
    input.title === fileNameBase || input.title === input.fileName;
  const titleNeedsLookup = titleIsFileName || isWeakPaperTitle(input.title);

  // 排版数据：原始页缺失 → 所有页都没有 links 字段 → 内部链接缺目标坐标 → 缺文本项。
  const linksMissingField =
    pages.length > 0 && pages.every((page) => page.links === undefined);
  const unresolvedLinks = countUnresolvedLinks(pages) > 0;
  const textMissing = !pagesHaveSelectableText(pages);
  const layoutReason: LayoutRepairReason = !input.originalReady
    ? "original-missing"
    : linksMissingField
      ? "links-missing"
      : unresolvedLinks
        ? "links-stale"
        : textMissing
          ? "text-missing"
          : "none";
  const layoutNeeded = layoutReason !== "none";

  const metadataReason: MetadataLookupReason = titleNeedsLookup
    ? "weak-title"
    : !input.impactFactor
      ? "impact-factor-missing"
      : "none";
  const metadataNeeded = metadataReason !== "none";

  return {
    layout: {
      reason: layoutReason,
      needed: layoutNeeded,
      due:
        layoutNeeded &&
        isBackfillDue(
          { checkedAt: input.linksCheckedAt, attempts: input.linksAttempts },
          now,
        ),
    },
    metadata: {
      reason: metadataReason,
      needed: metadataNeeded,
      due:
        metadataNeeded &&
        isBackfillDue(
          {
            checkedAt: input.metadataCheckedAt,
            attempts: input.metadataAttempts,
          },
          now,
        ),
      titleNeedsLookup,
    },
  };
}

/**
 * 记录一次尝试的结果。成功（该补齐的问题已解决）就把连续失败次数清零，
 * 否则累加；两种情况都刷新尝试时间，用于冷却判断。
 */
export function nextBackfillRecord(
  previous: BackfillRecord | undefined,
  succeeded: boolean,
  now: Date = new Date(),
): Required<BackfillRecord> {
  return {
    checkedAt: now.toISOString(),
    attempts: succeeded ? 0 : (previous?.attempts ?? 0) + 1,
  };
}
