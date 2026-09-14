import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  isWebSearchProviderId,
  validateWebSearchConfig,
  type WebSearchConfig,
  type WebSearchProviderId,
} from "./web-search";

/**
 * 联网搜索配置：data/search.json（明文，仅本机，不进备份、不进 Git）。
 * 与 lib/models-store.ts 同一套本地文件模式；读取时逐字段降级，坏文件不会让功能整体失效。
 */

export function webSearchFilePath(): string {
  // 测试可用 PAPERMATE_SEARCH_FILE 指向临时文件，避免写入真实 data/ 目录。
  return process.env.PAPERMATE_SEARCH_FILE || path.join(process.cwd(), "data", "search.json");
}

function readStoredJson(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(webSearchFilePath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 文件缺失或损坏：按默认配置处理 */
  }
  return {};
}

export function readWebSearchConfig(): WebSearchConfig {
  const stored = readStoredJson();
  const provider: WebSearchProviderId = isWebSearchProviderId(stored.provider)
    ? stored.provider
    : DEFAULT_WEB_SEARCH_CONFIG.provider;
  const apiKey = typeof stored.apiKey === "string" ? stored.apiKey : "";
  // 非 custom 的来源不保留 endpoint，避免残留值让校验失败。
  const endpoint = provider === "custom" && typeof stored.endpoint === "string" ? stored.endpoint : "";

  const result = validateWebSearchConfig({
    provider,
    apiKey,
    endpoint,
    count: stored.count,
    engine: stored.engine,
    recency: stored.recency,
    contentSize: stored.contentSize,
  });
  if (result.ok) return result.value;

  const fallback = validateWebSearchConfig({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    apiKey,
    count: stored.count,
    engine: stored.engine,
    recency: stored.recency,
    contentSize: stored.contentSize,
  });
  return fallback.ok ? fallback.value : { ...DEFAULT_WEB_SEARCH_CONFIG };
}

export function writeWebSearchConfig(config: WebSearchConfig): void {
  const filePath = webSearchFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${Date.now()}.tmp`;
  writeFileSync(tempFile, JSON.stringify(config, null, 2), "utf8");
  try {
    renameSync(tempFile, filePath);
  } catch {
    rmSync(filePath, { force: true });
    renameSync(tempFile, filePath);
  }
}

/** 实际用于请求的 Key：优先配置里的，智谱可回退到聊天用的 GLM Key。 */
export function resolveWebSearchKey(config: WebSearchConfig, glmKey?: string): string {
  const own = config.apiKey?.trim() ?? "";
  if (own) return own;
  return config.provider === "zhipu" ? (glmKey?.trim() ?? "") : "";
}
