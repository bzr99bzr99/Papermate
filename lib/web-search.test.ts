import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  buildSearchRequest,
  formatWebSearchBlock,
  linkifyCitations,
  nextWebSearchMode,
  normalizeSources,
  parseSearchResponse,
  shouldSearchWeb,
  validateWebSearchConfig,
  type WebSearchConfig,
  type WebSearchSource,
} from "./web-search";

function config(patch: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return { ...DEFAULT_WEB_SEARCH_CONFIG, ...patch };
}

const SOURCES: WebSearchSource[] = [
  { id: 1, title: "T", url: "https://a.com/1", snippet: "摘要一" },
  { id: 2, title: "U", url: "https://b.com/2", snippet: "摘要二" },
];

describe("buildSearchRequest", () => {
  it("builds the documented 智谱 web_search body", () => {
    const { url, init } = buildSearchRequest(config(), "最新的 GLM 版本", "glm-key");
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer glm-key");
    expect(JSON.parse(String(init.body))).toEqual({
      search_query: "最新的 GLM 版本",
      search_engine: "search_std",
      count: 8,
      search_recency_filter: "noLimit",
      content_size: "medium",
    });
  });

  it("uses each provider's own field names", () => {
    const bocha = buildSearchRequest(config({ provider: "bocha" }), "q", "k");
    expect(bocha.url).toBe("https://api.bochaai.com/v1/web-search");
    expect(JSON.parse(String(bocha.init.body))).toEqual({
      query: "q",
      freshness: "noLimit",
      summary: true,
      count: 8,
    });

    const tavily = buildSearchRequest(config({ provider: "tavily", count: 5 }), "q", "k");
    expect(tavily.url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(tavily.init.body))).toEqual({
      query: "q",
      max_results: 5,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    });
  });

  it("posts to the custom endpoint when configured", () => {
    const custom = buildSearchRequest(
      config({ provider: "custom", endpoint: "https://example.com/s" }),
      "q",
      "k",
    );
    expect(custom.url).toBe("https://example.com/s");
    expect(JSON.parse(String(custom.init.body))).toEqual({ query: "q", count: 8 });
  });
});

describe("parseSearchResponse", () => {
  it("maps 智谱 search_result entries", () => {
    const raw = parseSearchResponse("zhipu", {
      search_result: [
        { title: "T", link: "https://a.com/1", content: "C", media: "搜狐", publish_date: "2025-05-23" },
      ],
    });
    expect(raw).toEqual([
      { title: "T", url: "https://a.com/1", snippet: "C", site: "搜狐", publishedAt: "2025-05-23" },
    ]);
  });

  it("maps 博查 data.webPages.value and prefers summary over snippet", () => {
    const raw = parseSearchResponse("bocha", {
      code: 200,
      data: {
        webPages: {
          value: [
            {
              name: "N",
              url: "https://b.com/1",
              snippet: "短",
              summary: "长摘要",
              siteName: "站点",
              datePublished: "2026-01-02T09:00:00+08:00",
            },
          ],
        },
      },
    });
    expect(raw[0].title).toBe("N");
    expect(raw[0].snippet).toBe("长摘要");
    expect(raw[0].site).toBe("站点");
  });

  it("maps Tavily results", () => {
    const raw = parseSearchResponse("tavily", {
      results: [{ title: "T", url: "https://c.com", content: "C", published_date: "2026-03-04" }],
    });
    expect(raw).toEqual([{ title: "T", url: "https://c.com", snippet: "C", site: undefined, publishedAt: "2026-03-04" }]);
  });

  it("returns an empty list instead of throwing on unexpected payloads", () => {
    expect(parseSearchResponse("zhipu", null)).toEqual([]);
    expect(parseSearchResponse("bocha", { data: null })).toEqual([]);
    expect(parseSearchResponse("tavily", { results: "nope" })).toEqual([]);
    expect(parseSearchResponse("custom", 42)).toEqual([]);
  });
});

describe("normalizeSources", () => {
  it("dedupes by url, renumbers from 1, and drops non-http links", () => {
    const result = normalizeSources([
      { title: "A", url: "https://a.com/1", snippet: "x" },
      { title: "A2", url: "https://a.com/1", snippet: "dup" },
      { title: "B", url: "ftp://b.com", snippet: "skip" },
      { title: "", url: "https://c.com/x", snippet: "" },
    ]);
    expect(result.map((source) => source.id)).toEqual([1, 2]);
    expect(result[0].title).toBe("A");
    // 缺标题时用域名兜底，站点也按域名补全
    expect(result[1].title).toBe("c.com");
    expect(result[1].site).toBe("c.com");
  });

  it("truncates long snippets and caps the count", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      title: `T${index}`,
      url: `https://e.com/${index}`,
      snippet: "字".repeat(900),
    }));
    const result = normalizeSources(many);
    expect(result).toHaveLength(8);
    expect(result[0].snippet).toHaveLength(500);
    expect(normalizeSources(many, 3)).toHaveLength(3);
  });

  it("normalizes published dates to YYYY-MM-DD", () => {
    const [source] = normalizeSources([
      { title: "T", url: "https://a.com", publishedAt: "2026年1月2日 10:00" },
    ]);
    expect(source.publishedAt).toBe("2026-01-02");
  });
});

describe("formatWebSearchBlock", () => {
  it("formats a numbered block with url and snippet", () => {
    const sources = normalizeSources([
      { title: "T", url: "https://a.com/1", snippet: "摘要", site: "站点", publishedAt: "2026-01-02" },
    ]);
    const block = formatWebSearchBlock(sources, { now: new Date(2026, 8, 8) });
    expect(block).toContain("【联网检索结果】检索时间：2026-09-08");
    expect(block).toContain("[1] T · 站点 · 2026-01-02");
    expect(block).toContain("https://a.com/1");
    expect(block).toContain("摘要");
  });

  it("returns an empty string without sources and notes omitted entries", () => {
    expect(formatWebSearchBlock([])).toBe("");
    const sources = normalizeSources([{ title: "T", url: "https://a.com/1", snippet: "字".repeat(500) }]);
    expect(formatWebSearchBlock(sources, { limit: 200 })).toContain("省略了 1 条");
  });
});

describe("linkifyCitations", () => {
  it("turns [n] into a markdown link when the source exists", () => {
    expect(linkifyCitations("结论见 [1] 与 [2]。", SOURCES)).toBe(
      "结论见 [1](https://a.com/1) 与 [2](https://b.com/2)。",
    );
  });

  it("leaves unknown numbers, existing links and code alone", () => {
    expect(linkifyCitations("越界 [9]", SOURCES)).toBe("越界 [9]");
    expect(linkifyCitations("已链接 [1](https://x.com)", SOURCES)).toBe("已链接 [1](https://x.com)");
    expect(linkifyCitations("```\n[1]\n```", SOURCES)).toBe("```\n[1]\n```");
    expect(linkifyCitations("行内 `[1]` 保留", SOURCES)).toBe("行内 `[1]` 保留");
  });

  it("is a no-op without sources", () => {
    expect(linkifyCitations("见 [1]", [])).toBe("见 [1]");
  });
});

describe("shouldSearchWeb", () => {
  it("stays off when the mode is off", () => {
    expect(shouldSearchWeb("free", "GLM 最新的版本是什么", "off")).toBe(false);
  });

  it("never searches for paper-only tasks", () => {
    for (const kind of ["translate", "notes", "mindmap", "writing"] as const) {
      expect(shouldSearchWeb(kind, "GLM 最新的版本是什么", "force")).toBe(false);
    }
  });

  it("always searches in force mode as long as there is a question", () => {
    expect(shouldSearchWeb("free", "这段在说什么", "force")).toBe(true);
    expect(shouldSearchWeb("free", "   ", "force")).toBe(false);
  });

  it("needs an external hint and no paper-only wording in auto mode", () => {
    expect(shouldSearchWeb("free", "GLM 最新的版本是什么", "auto")).toBe(true);
    expect(shouldSearchWeb("free", "本文的方法有什么创新", "auto")).toBe(false);
    expect(shouldSearchWeb("free", "这段图 3 说明了什么", "auto")).toBe(false);
    expect(shouldSearchWeb("free", "你好", "auto")).toBe(false);
  });
});

describe("validateWebSearchConfig", () => {
  it("requires a valid endpoint only for the custom provider", () => {
    expect(validateWebSearchConfig({ provider: "custom", endpoint: "" }).ok).toBe(false);
    expect(validateWebSearchConfig({ provider: "custom", endpoint: "ftp://x" }).ok).toBe(false);
    expect(validateWebSearchConfig({ provider: "custom", endpoint: "https://x.com/s" }).ok).toBe(true);
    expect(validateWebSearchConfig({ provider: "zhipu", endpoint: "https://x.com/s" }).ok).toBe(false);
  });

  it("clamps the count and falls back for unknown enum values", () => {
    const high = validateWebSearchConfig({ provider: "zhipu", count: 99, engine: "nonsense" });
    expect(high.ok).toBe(true);
    if (!high.ok) return;
    expect(high.value.count).toBe(20);
    expect(high.value.engine).toBe("search_std");
  });

  it("keeps the stored key when apiKey is omitted and clears it on an empty string", () => {
    const kept = validateWebSearchConfig({ provider: "zhipu" });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.value.apiKey).toBeUndefined();

    const cleared = validateWebSearchConfig({ provider: "zhipu", apiKey: "" });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.apiKey).toBe("");
  });

  it("rejects non-object input", () => {
    expect(validateWebSearchConfig(null).ok).toBe(false);
    expect(validateWebSearchConfig("zhipu").ok).toBe(false);
  });
});

describe("nextWebSearchMode", () => {
  it("cycles off → auto → force → off", () => {
    expect(nextWebSearchMode("off")).toBe("auto");
    expect(nextWebSearchMode("auto")).toBe("force");
    expect(nextWebSearchMode("force")).toBe("off");
  });
});
