import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readWebSearchConfig,
  resolveWebSearchKey,
  webSearchFilePath,
  writeWebSearchConfig,
} from "./web-search-store";
import { DEFAULT_WEB_SEARCH_CONFIG, toWebSearchConfigView } from "./web-search";

let tempDir = "";
let previousEnv: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "papermate-search-"));
  previousEnv = process.env.PAPERMATE_SEARCH_FILE;
  process.env.PAPERMATE_SEARCH_FILE = path.join(tempDir, "search.json");
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env.PAPERMATE_SEARCH_FILE;
  else process.env.PAPERMATE_SEARCH_FILE = previousEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("web search config store", () => {
  it("returns defaults when nothing has been saved yet", () => {
    expect(readWebSearchConfig()).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
  });

  it("round-trips a saved config", () => {
    writeWebSearchConfig({
      provider: "bocha",
      apiKey: "sk-bocha",
      endpoint: "",
      count: 5,
      engine: "search_pro",
      recency: "oneMonth",
      contentSize: "high",
    });
    const loaded = readWebSearchConfig();
    expect(loaded.provider).toBe("bocha");
    expect(loaded.apiKey).toBe("sk-bocha");
    expect(loaded.count).toBe(5);
    expect(loaded.recency).toBe("oneMonth");
    // 非 custom 来源不保留接口地址
    expect(loaded.endpoint).toBe("");
  });

  it("falls back to defaults instead of throwing on a corrupt file", () => {
    writeFileSync(webSearchFilePath(), "{ not json", "utf8");
    expect(readWebSearchConfig()).toEqual(DEFAULT_WEB_SEARCH_CONFIG);
  });

  it("keeps usable fields when only the provider is unknown", () => {
    writeFileSync(
      webSearchFilePath(),
      JSON.stringify({ provider: "nope", count: 6, apiKey: "k" }),
      "utf8",
    );
    const loaded = readWebSearchConfig();
    expect(loaded.provider).toBe("zhipu");
    expect(loaded.count).toBe(6);
    expect(loaded.apiKey).toBe("k");
  });

  it("drops a stale custom endpoint when the provider is no longer custom", () => {
    writeFileSync(
      webSearchFilePath(),
      JSON.stringify({ provider: "zhipu", endpoint: "not-a-url" }),
      "utf8",
    );
    expect(readWebSearchConfig().endpoint).toBe("");
  });

  it("writes readable JSON with the key included", () => {
    writeWebSearchConfig({ ...DEFAULT_WEB_SEARCH_CONFIG, apiKey: "sk-X" });
    expect(readFileSync(webSearchFilePath(), "utf8")).toContain('"apiKey": "sk-X"');
  });
});

describe("resolveWebSearchKey", () => {
  it("prefers the dedicated search key", () => {
    expect(resolveWebSearchKey({ ...DEFAULT_WEB_SEARCH_CONFIG, apiKey: "own" }, "glm")).toBe("own");
  });

  it("falls back to the GLM key only for 智谱", () => {
    expect(resolveWebSearchKey(DEFAULT_WEB_SEARCH_CONFIG, "glm")).toBe("glm");
    expect(resolveWebSearchKey({ ...DEFAULT_WEB_SEARCH_CONFIG, provider: "tavily" }, "glm")).toBe("");
  });
});

describe("toWebSearchConfigView", () => {
  it("never exposes the key itself", () => {
    const view = toWebSearchConfigView({ ...DEFAULT_WEB_SEARCH_CONFIG, apiKey: "secret" }, "glm");
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(view.hasKey).toBe(true);
    expect(view.usingGlmKey).toBe(false);
  });

  it("reports when 智谱 will reuse the saved GLM key", () => {
    const view = toWebSearchConfigView({ ...DEFAULT_WEB_SEARCH_CONFIG, apiKey: "" }, "glm");
    expect(view.hasKey).toBe(false);
    expect(view.usingGlmKey).toBe(true);
  });
});
