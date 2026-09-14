import { NextResponse } from "next/server";
import { readApiKeyFile } from "@/lib/api-keys";
import { readWebSearchConfig, resolveWebSearchKey } from "@/lib/web-search-store";
import {
  SEARCH_PROVIDER_META,
  WEB_SEARCH_QUERY_LIMIT,
  WEB_SEARCH_TIMEOUT_MS,
  buildSearchRequest,
  normalizeSources,
  parseSearchResponse,
} from "@/lib/web-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 联网搜索执行口：服务端持有密钥并真正发起检索，浏览器只拿到归一化后的来源。
 * 统一返回 HTTP 200 + { ok } 布尔，客户端只需一条分支：
 *   成功 { ok: true, provider, query, tookMs, results }
 *   失败 { ok: false, code, error, rawSnippet? }
 * rawSnippet 是上游报文片段（≤300 字），仅供设置页「测试连接」排错。
 */

const noStore = { "Cache-Control": "no-store" };

export type WebSearchFailureCode =
  | "no_key"
  | "invalid_key"
  | "quota"
  | "network"
  | "bad_response"
  | "bad_query"
  | "no_endpoint";

const RAW_SNIPPET_LIMIT = 300;

function fail(code: WebSearchFailureCode, error: string, rawSnippet?: string) {
  return NextResponse.json(
    { ok: false, code, error, ...(rawSnippet ? { rawSnippet } : {}) },
    { headers: noStore },
  );
}

function providerLabel(id: string): string {
  return SEARCH_PROVIDER_META.find((item) => item.id === id)?.label ?? "搜索服务";
}

/** 上游错误报文里的可读原因（各家结构不一，尽力而为）。 */
function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; msg?: unknown };
    const raw = parsed.error?.message ?? parsed.message ?? parsed.msg;
    return typeof raw === "string" ? raw.trim().slice(0, 120) : "";
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { query?: string; test?: boolean };
  const isTest = body.test === true;

  const config = readWebSearchConfig();
  const glmKey = readApiKeyFile().glm;
  const apiKey = resolveWebSearchKey(config, glmKey);
  const label = providerLabel(config.provider);

  if (config.provider === "custom" && !config.endpoint?.trim()) {
    return fail("no_endpoint", "请先在设置中填写自定义搜索接口地址。");
  }
  if (!apiKey) {
    return fail(
      "no_key",
      config.provider === "zhipu"
        ? "请先在设置中配置智谱 API Key（联网搜索会复用它），或为联网搜索单独指定 Key。"
        : `请先在设置中配置「${label}」的搜索 API Key。`,
    );
  }

  // 设置页的测试连接用固定 query；正常检索用用户提问（只发问题本身，不发论文正文）。
  const query = (isTest ? "PaperMate 论文助手 联网搜索测试" : body.query?.trim() ?? "").slice(0, WEB_SEARCH_QUERY_LIMIT);
  if (!query) return fail("bad_query", "请先输入要检索的问题。");

  const { url, init } = buildSearchRequest(config, query, apiKey);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return fail(
      "network",
      timedOut ? `联网检索超时（超过 ${WEB_SEARCH_TIMEOUT_MS / 1000} 秒）。` : `无法连接${label}，请检查网络后重试。`,
    );
  }

  const text = await response.text().catch(() => "");
  const rawSnippet = text.slice(0, RAW_SNIPPET_LIMIT);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return fail("invalid_key", `${label} 拒绝了这次请求：API Key 无效或没有该接口的权限。`, rawSnippet);
    }
    if (response.status === 402 || response.status === 429) {
      const detail = upstreamMessage(text);
      // 智谱把「余额不足或无可用的资源包」也返回成 429（错误码 1113），和限流要分开说。
      const needsTopUp = /余额不足|无可用的资源包|欠费|充值|insufficient|no available resource/i.test(`${detail} ${text}`);
      return fail(
        "quota",
        needsTopUp
          ? `${label} 账户余额或资源包不足${detail ? `（${detail}）` : ""}：请先在对应平台充值/购买搜索资源包，或到设置里改用博查、Tavily 等其它搜索服务。`
          : `${label} 额度不足或触发限流（HTTP ${response.status}）${detail ? `：${detail}` : ""}。`,
        rawSnippet,
      );
    }
    return fail("network", `${label} 请求失败（HTTP ${response.status}）。`, rawSnippet);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("bad_response", `${label} 返回的内容不是合法 JSON。`, rawSnippet);
  }

  // 博查等接口用 body 里的 code 表达业务错误。
  const businessCode = (payload as { code?: unknown } | null)?.code;
  const results = normalizeSources(parseSearchResponse(config.provider, payload));
  if (!results.length && typeof businessCode === "number" && businessCode !== 200) {
    return fail("bad_response", `${label} 返回错误码 ${businessCode}。`, rawSnippet);
  }

  return NextResponse.json(
    {
      ok: true,
      provider: config.provider,
      query,
      tookMs: Date.now() - started,
      results,
      ...(isTest ? { rawSnippet } : {}),
    },
    { headers: noStore },
  );
}
