/**
 * 联网搜索适配层：纯逻辑，不依赖 node:fs / React，客户端与服务端都能导入。
 *
 * 分工：
 * - 本文件：构造请求、解析响应、归一化、拼提示词注入块、角标可点击化、是否需要联网。
 * - app/api/web-search/route.ts：真正发起 fetch（密钥只留在服务端）。
 * - lib/web-search-store.ts：data/search.json 的读写（含 node:fs，仅服务端导入）。
 *
 * 设计要点：搜索是独立服务，与聊天模型解耦——DeepSeek / Kimi / 自定义模型都能联网；
 * /api/chat 保持纯 SSE 透传，不引入 tool-calling。
 */

/** 联网开关：关闭 / 自动（规则判断）/ 强制每次都搜。 */
export type WebSearchMode = "off" | "auto" | "force";

export type WebSearchProviderId = "zhipu" | "bocha" | "tavily" | "custom";

/** 智谱搜索引擎档位（价格来自官方价格表：0.01 / 0.03 / 0.05 元每次）。 */
type ZhipuSearchEngine = "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";

type WebSearchRecency = "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear";

type WebSearchContentSize = "medium" | "high";

/** 与 PromptKind / ArtifactKind 对齐（此处独立声明，避免与 lib/types.ts 形成循环依赖）。 */
type WebSearchTaskKind =
  | "translate"
  | "context"
  | "concept"
  | "free"
  | "notes"
  | "mindmap"
  | "writing";

export interface WebSearchConfig {
  provider: WebSearchProviderId;
  /** 智谱留空 = 复用 data/apikey.txt 里的 GLM Key。 */
  apiKey?: string;
  /** 仅 provider === "custom" 必填。 */
  endpoint?: string;
  /** 返回条数（1-20，默认 8）。 */
  count: number;
  engine?: ZhipuSearchEngine;
  recency?: WebSearchRecency;
  contentSize?: WebSearchContentSize;
}

/** 归一化后的单条来源：id 即回答里 [1][2] 的编号。 */
export interface WebSearchSource {
  id: number;
  title: string;
  url: string;
  snippet: string;
  site?: string;
  publishedAt?: string;
}

/** 各家响应里可能出现的字段（未经校验）。 */
export interface RawWebSearchSource {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  site?: unknown;
  publishedAt?: unknown;
}

const WEB_SEARCH_MAX_RESULTS = 8;
const WEB_SEARCH_SNIPPET_LIMIT = 500;
const WEB_SEARCH_BLOCK_LIMIT = 6000;
export const WEB_SEARCH_TIMEOUT_MS = 8000;
export const WEB_SEARCH_QUERY_LIMIT = 200;

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  provider: "zhipu",
  apiKey: "",
  endpoint: "",
  count: WEB_SEARCH_MAX_RESULTS,
  engine: "search_std",
  recency: "noLimit",
  contentSize: "medium",
};

interface WebSearchProviderMeta {
  id: WebSearchProviderId;
  label: string;
  /** 是否可以复用聊天用的智谱 Key（只有 zhipu 可以）。 */
  reuseGlmKey: boolean;
  defaultEndpoint: string;
  hint: string;
}

export const SEARCH_PROVIDER_META: WebSearchProviderMeta[] = [
  {
    id: "zhipu",
    label: "智谱 Web Search",
    reuseGlmKey: true,
    defaultEndpoint: "https://open.bigmodel.cn/api/paas/v4/web_search",
    hint: "国内直连，可复用上方智谱 API Key；search_std 约 ¥10/1000 次。",
  },
  {
    id: "bocha",
    label: "博查 Bocha",
    reuseGlmKey: false,
    defaultEndpoint: "https://api.bochaai.com/v1/web-search",
    hint: "国内直连，需在 open.bochaai.com 单独申请 Key（有 3 个月 1000 次试用）。",
  },
  {
    id: "tavily",
    label: "Tavily",
    reuseGlmKey: false,
    defaultEndpoint: "https://api.tavily.com/search",
    hint: "英文与学术内容质量更好，但为境外服务，需要能稳定访问；每月 1000 credits 免费。",
  },
  {
    id: "custom",
    label: "自定义搜索 API",
    reuseGlmKey: false,
    defaultEndpoint: "",
    hint: "填任意 OpenAI 风格 {query, count} 的搜索接口，返回 results / data.webPages.value 均可识别。",
  },
];

export const ZHIPU_SEARCH_ENGINES: Array<{ id: ZhipuSearchEngine; label: string }> = [
  { id: "search_std", label: "基础版 search_std · ¥10/1000 次" },
  { id: "search_pro", label: "高级版 search_pro · ¥30/1000 次" },
  { id: "search_pro_sogou", label: "搜狗版 · ¥50/1000 次" },
  { id: "search_pro_quark", label: "夸克版 · ¥50/1000 次" },
];

export const WEB_SEARCH_RECENCY_OPTIONS: Array<{ id: WebSearchRecency; label: string }> = [
  { id: "noLimit", label: "不限时间" },
  { id: "oneDay", label: "一天内" },
  { id: "oneWeek", label: "一周内" },
  { id: "oneMonth", label: "一月内" },
  { id: "oneYear", label: "一年内" },
];

export const WEB_SEARCH_CONTENT_SIZE_OPTIONS: Array<{ id: WebSearchContentSize; label: string }> = [
  { id: "medium", label: "摘要适中" },
  { id: "high", label: "摘要更长" },
];

const PROVIDER_IDS = SEARCH_PROVIDER_META.map((item) => item.id);
const ENGINE_IDS = ZHIPU_SEARCH_ENGINES.map((item) => item.id);
const RECENCY_IDS = WEB_SEARCH_RECENCY_OPTIONS.map((item) => item.id);
const CONTENT_SIZE_IDS = WEB_SEARCH_CONTENT_SIZE_OPTIONS.map((item) => item.id);

export function isWebSearchMode(value: unknown): value is WebSearchMode {
  return value === "off" || value === "auto" || value === "force";
}

export function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return PROVIDER_IDS.includes(value as WebSearchProviderId);
}

function asText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 设置页保存前的统一校验（客户端/服务端共用）。 */
export function validateWebSearchConfig(
  input: unknown,
): { ok: true; value: WebSearchConfig } | { ok: false; errors: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["联网搜索配置格式无效。"] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  const provider = PROVIDER_IDS.includes(raw.provider as WebSearchProviderId)
    ? (raw.provider as WebSearchProviderId)
    : DEFAULT_WEB_SEARCH_CONFIG.provider;

  const endpoint = asText(raw.endpoint, 500);
  if (provider === "custom") {
    if (!endpoint) errors.push("请填写自定义搜索接口地址。");
    else {
      try {
        const parsed = new URL(endpoint);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push("搜索接口地址必须以 http:// 或 https:// 开头。");
        }
      } catch {
        errors.push("搜索接口地址不是合法的 URL。");
      }
    }
  } else if (endpoint) {
    errors.push("只有「自定义搜索 API」需要填写接口地址。");
  }

  const rawCount = typeof raw.count === "number" ? raw.count : Number(raw.count);
  const count = Number.isFinite(rawCount) ? Math.min(20, Math.max(1, Math.round(rawCount))) : DEFAULT_WEB_SEARCH_CONFIG.count;

  // apiKey === undefined 表示「保持已保存的 Key 不变」，空字符串表示「清空」。
  let apiKey: string | undefined;
  if (raw.apiKey === undefined) apiKey = undefined;
  else if (raw.apiKey === null) apiKey = "";
  else {
    const text = asText(raw.apiKey, 500);
    if (typeof raw.apiKey === "string" && raw.apiKey.trim().length > 500) errors.push("API Key 不能超过 500 个字符。");
    apiKey = text;
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      provider,
      count,
      engine: ENGINE_IDS.includes(raw.engine as ZhipuSearchEngine)
        ? (raw.engine as ZhipuSearchEngine)
        : DEFAULT_WEB_SEARCH_CONFIG.engine,
      recency: RECENCY_IDS.includes(raw.recency as WebSearchRecency)
        ? (raw.recency as WebSearchRecency)
        : DEFAULT_WEB_SEARCH_CONFIG.recency,
      contentSize: CONTENT_SIZE_IDS.includes(raw.contentSize as WebSearchContentSize)
        ? (raw.contentSize as WebSearchContentSize)
        : DEFAULT_WEB_SEARCH_CONFIG.contentSize,
      endpoint,
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  };
}

/** 用当前配置拼出一次搜索的 HTTP 请求（纯函数，便于单测断言 URL / Header / body）。 */
export function buildSearchRequest(
  config: WebSearchConfig,
  query: string,
  apiKey: string,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const meta = SEARCH_PROVIDER_META.find((item) => item.id === config.provider);
  const url = config.provider === "custom" ? (config.endpoint ?? "") : meta?.defaultEndpoint ?? "";

  let body: Record<string, unknown>;
  switch (config.provider) {
    case "bocha":
      body = {
        query,
        freshness: config.recency ?? "noLimit",
        summary: true,
        count: config.count,
      };
      break;
    case "tavily":
      body = {
        query,
        max_results: config.count,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      };
      break;
    case "custom":
      body = { query, count: config.count };
      break;
    case "zhipu":
    default:
      body = {
        search_query: query,
        search_engine: config.engine ?? "search_std",
        count: config.count,
        search_recency_filter: config.recency ?? "noLimit",
        content_size: config.contentSize ?? "medium",
      };
      break;
  }

  return {
    url,
    init: {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(body),
    },
  };
}

function fromZhipu(payload: unknown): RawWebSearchSource[] {
  return asArray(pick(payload, ["search_result"])).map((item) => ({
    title: pick(item, ["title"]),
    url: pick(item, ["link"]),
    snippet: pick(item, ["content"]),
    site: pick(item, ["media"]),
    publishedAt: pick(item, ["publish_date"]),
  }));
}

function fromBocha(payload: unknown): RawWebSearchSource[] {
  return asArray(pick(payload, ["data", "webPages", "value"])).map((item) => ({
    title: pick(item, ["name"]),
    url: pick(item, ["url"]),
    snippet: pick(item, ["summary"]) ?? pick(item, ["snippet"]),
    site: pick(item, ["siteName"]),
    publishedAt: pick(item, ["datePublished"]),
  }));
}

function fromTavily(payload: unknown): RawWebSearchSource[] {
  return asArray(pick(payload, ["results"])).map((item) => ({
    title: pick(item, ["title"]),
    url: pick(item, ["url"]),
    snippet: pick(item, ["content"]),
    publishedAt: pick(item, ["published_date"]),
  }));
}

/** 自定义接口：把常见的几种结果结构都试一遍，全部落空时返回空数组。 */
function fromCustom(payload: unknown): RawWebSearchSource[] {
  const candidates = [
    pick(payload, ["results"]),
    pick(payload, ["data", "results"]),
    pick(payload, ["data", "webPages", "value"]),
    pick(payload, ["webPages", "value"]),
    pick(payload, ["data"]),
  ];
  const list = candidates.find((item) => Array.isArray(item));
  return asArray(list).map((item) => ({
    title: pick(item, ["title"]) ?? pick(item, ["name"]),
    url: pick(item, ["url"]) ?? pick(item, ["link"]),
    snippet: pick(item, ["snippet"]) ?? pick(item, ["summary"]) ?? pick(item, ["content"]) ?? pick(item, ["description"]),
    site: pick(item, ["siteName"]) ?? pick(item, ["site"]) ?? pick(item, ["media"]),
    publishedAt: pick(item, ["publishedAt"]) ?? pick(item, ["published_date"]) ?? pick(item, ["datePublished"]),
  }));
}

/** 解析各家响应（只做结构映射，不做校验；字段缺失/结构异常都返回空数组而不抛错）。 */
export function parseSearchResponse(provider: WebSearchProviderId, payload: unknown): RawWebSearchSource[] {
  try {
    switch (provider) {
      case "bocha":
        return fromBocha(payload);
      case "tavily":
        return fromTavily(payload);
      case "custom":
        return fromCustom(payload);
      case "zhipu":
      default:
        return fromZhipu(payload);
    }
  } catch {
    return [];
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalizeDate(value: unknown): string | undefined {
  const text = asText(value, 40);
  if (!text) return undefined;
  const match = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!match) return text;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * 归一化：按 url 去重、丢弃非 http(s) 链接、压缩空白、截断摘要、
 * **从 1 重新编号**（编号即回答里的角标），并限制总条数。
 */
export function normalizeSources(
  raw: RawWebSearchSource[],
  limit: number = WEB_SEARCH_MAX_RESULTS,
): WebSearchSource[] {
  const seen = new Set<string>();
  const result: WebSearchSource[] = [];
  for (const item of raw) {
    const url = asText(item.url, 2000);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = asText(item.title, 200) || hostnameOf(url) || "未命名网页";
    const snippet = asText(item.snippet, WEB_SEARCH_SNIPPET_LIMIT * 2).replace(/\s+/g, " ").slice(0, WEB_SEARCH_SNIPPET_LIMIT);
    const site = asText(item.site, 60) || hostnameOf(url);
    const publishedAt = normalizeDate(item.publishedAt);
    result.push({
      id: result.length + 1,
      title,
      url,
      snippet,
      ...(site ? { site } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (result.length >= limit) break;
  }
  return result;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 拼「注入到用户消息里」的联网检索块；总长受 limit 约束，超出部分按条省略并注明。 */
export function formatWebSearchBlock(
  sources: WebSearchSource[],
  options: { now?: Date; limit?: number } = {},
): string {
  if (!sources.length) return "";
  const limit = options.limit ?? WEB_SEARCH_BLOCK_LIMIT;
  const head = `【联网检索结果】检索时间：${formatDay(options.now ?? new Date())}。以下内容来自公开网页，不是论文原文；引用时用编号角标（例如 [1]），并把它归到网页资料而不是论文出处。`;
  const entries: string[] = [];
  let used = head.length;
  let omitted = 0;
  for (const source of sources) {
    const meta = [source.title, source.site, source.publishedAt].filter(Boolean).join(" · ");
    const entry = `[${source.id}] ${meta}\n    ${source.url}\n    ${source.snippet}`;
    if (used + entry.length > limit) {
      omitted += 1;
      continue;
    }
    entries.push(entry);
    used += entry.length + 1;
  }
  const tail = omitted ? `\n（因长度限制省略了 ${omitted} 条检索结果）` : "";
  return [head, ...entries].join("\n") + tail;
}

/**
 * 把回答里的 [1][2] 变成可点击的 Markdown 链接。
 * - 围栏代码块与行内代码内不替换
 * - 已经是 [1](url) 的写法不二次包装（负向断言）
 * - 编号超出来源范围的（模型编造）保持纯文本
 */
export function linkifyCitations(text: string, sources: WebSearchSource[]): string {
  if (!text || !sources.length) return text;
  const byId = new Map(sources.map((source) => [source.id, source]));
  const replaceIn = (segment: string) =>
    segment.replace(/\[(\d{1,2})\](?!\()/g, (match, digits: string) => {
      const source = byId.get(Number(digits));
      return source ? `[${digits}](${source.url})` : match;
    });
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk;
      return chunk
        .split(/(`[^`\n]*`)/g)
        .map((piece, pieceIndex) => (pieceIndex % 2 === 1 ? piece : replaceIn(piece)))
        .join("");
    })
    .join("");
}

/** 这些任务只针对当前论文本身，永远不联网。 */
const NEVER_SEARCH_KINDS: WebSearchTaskKind[] = ["translate", "notes", "mindmap", "writing"];

/** 纯论文指向词：命中说明用户问的是「本文」，自动模式下不联网。 */
const PAPER_ONLY_PATTERNS: RegExp[] = [
  /本文/,
  /本篇/,
  /这篇/,
  /该论文/,
  /论文中/,
  /论文里/,
  /文中/,
  /这段/,
  /这句/,
  /该段/,
  /选段/,
  /摘要中/,
  /方法部分/,
  /实验结果/,
  /图\s*\d/,
  /表\s*\d/,
  /公式/,
];

/** 外部指向词：命中说明可能需要论文之外的最新信息。 */
const EXTERNAL_HINT_PATTERNS: RegExp[] = [
  /最新/,
  /最近/,
  /近期/,
  /今年/,
  /去年/,
  /现在/,
  /目前/,
  /当前/,
  /20(2[4-9]|3\d)/,
  /官网/,
  /价格/,
  /多少钱/,
  /收费/,
  /发布/,
  /新闻/,
  /公司/,
  /产品/,
  /版本/,
  /下载/,
  /开源/,
  /谁是/,
  /哪家/,
  /对比/,
  /区别/,
  /搜一下/,
  /搜下/,
  /查一下/,
  /搜一搜/,
  /联网/,
  /网上/,
];

/**
 * 是否需要联网（纯规则，不额外调模型）。
 * - 关闭 → false；翻译/笔记/脑图/写作分析 → 永远 false
 * - 强制 → 只要问题非空就搜（用户显式要求，不再做论文指向词过滤）
 * - 自动 → 问题够长、不含论文指向词、且命中外部指向词才搜
 */
export function shouldSearchWeb(kind: WebSearchTaskKind, question: string, mode: WebSearchMode): boolean {
  if (mode === "off") return false;
  if (NEVER_SEARCH_KINDS.includes(kind)) return false;
  const text = question.trim();
  if (mode === "force") return text.length > 0;
  if (text.length < 4) return false;
  if (PAPER_ONLY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return EXTERNAL_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

/** 开关按钮的展示文案与说明（三态循环：关闭 → 自动 → 强制 → 关闭）。 */
export const WEB_SEARCH_MODE_LABELS: Record<WebSearchMode, { button: string; title: string }> = {
  off: {
    button: "联网",
    title: "联网搜索：已关闭。点击切换为「自动」（按问题判断是否需要联网）",
  },
  auto: {
    button: "联网 · 自动",
    title: "联网搜索：自动。命中外部指向词时才联网；翻译、笔记、脑图、写作分析永不联网。点击切换为「强制」",
  },
  force: {
    button: "联网 · 强制",
    title: "联网搜索：强制。每次提问都先检索网页。点击关闭联网",
  },
};

export function nextWebSearchMode(mode: WebSearchMode): WebSearchMode {
  return mode === "off" ? "auto" : mode === "auto" ? "force" : "off";
}

/** 设置页读取用的脱敏视图：绝不包含明文 Key。 */
export interface WebSearchConfigView {
  provider: WebSearchProviderId;
  endpoint: string;
  count: number;
  engine?: ZhipuSearchEngine;
  recency?: WebSearchRecency;
  contentSize?: WebSearchContentSize;
  /** 已单独配置了搜索 Key。 */
  hasKey: boolean;
  /** 未单独配置，但可以复用已保存的智谱 Key。 */
  usingGlmKey: boolean;
}

export function toWebSearchConfigView(config: WebSearchConfig, glmKey?: string): WebSearchConfigView {
  const hasOwnKey = Boolean(config.apiKey?.trim());
  return {
    provider: config.provider,
    endpoint: config.endpoint ?? "",
    count: config.count,
    engine: config.engine,
    recency: config.recency,
    contentSize: config.contentSize,
    hasKey: hasOwnKey,
    usingGlmKey: !hasOwnKey && config.provider === "zhipu" && Boolean(glmKey?.trim()),
  };
}
