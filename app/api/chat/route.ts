import { NextResponse } from "next/server";
import { loadSystemPrompt, loadTaskInstructions, type Task } from "@/lib/prompts";
import { readApiKeyFile } from "@/lib/api-keys";
import { resolveModel, type ResolvedModel } from "@/lib/models-store";
import type { CustomModelConfig } from "@/lib/models";

export const runtime = "nodejs";

type IncomingMessage = { role: "user" | "assistant"; content: string };
type Provider = "deepseek" | "glm" | "kimi";

const providerTargets: Record<Provider, { url: string; model: string; fallbackModels?: string[]; label: string }> = {
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    label: "DeepSeek",
  },
  glm: {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    // 双档模型：glm-4-flash（智谱免费模型，官方支持高并发）与 glm-4.7-flash；
    // 两档互作 404 回退候选。快速/深度由 thinking 参数控制（两档均支持）。
    model: "glm-4-flash",
    fallbackModels: ["glm-4.7-flash"],
    label: "GLM",
  },
  kimi: {
    url: "https://api.moonshot.cn/v1/chat/completions",
    // 模型名随账号可用性变化：kimi-k2.5 已不再对所有账号开放（实测 404 Model Not Exist），
    // 当前账号可用 kimi-k2.6 / kimi-k2.7-code / kimi-k2.7-code-highspeed / kimi-k3。
    // 请求 404（模型不存在）时依次回退到后面的候选模型。
    model: "kimi-k2.6",
    fallbackModels: ["kimi-k3", "kimi-k2.5"],
    label: "Kimi",
  },
};

/** 内置模型下拉 → 具体模型代号（modelId 与文字标签一一对应）。 */
const modelById: Record<string, { provider: Provider; model: string; fallbackModels?: string[] }> = {
  "glm-flash": { provider: "glm", model: "glm-4-flash", fallbackModels: ["glm-4.7-flash"] },
  "glm-47": { provider: "glm", model: "glm-4.7-flash", fallbackModels: ["glm-4-flash"] },
  "deepseek-flash": { provider: "deepseek", model: "deepseek-v4-flash" },
  kimi: { provider: "kimi", model: "kimi-k2.6", fallbackModels: ["kimi-k3", "kimi-k2.5"] },
};

function sseTextStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const rows = buffer.split("\n");
          buffer = rows.pop() ?? "";
          for (const row of rows) {
            if (!row.startsWith("data:")) continue;
            const valueText = row.slice(5).trim();
            if (!valueText || valueText === "[DONE]") continue;
            try {
              const parsed = JSON.parse(valueText) as { choices?: Array<{ delta?: { content?: string } }> };
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) controller.enqueue(encoder.encode(content));
            } catch {
              // Ignore incomplete or non-content SSE frames.
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

/** 可重试的上游错误（GLM 免费档 429 冷却窗口较长，用递增退避覆盖）。 */
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [3000, 7000, 13000];

interface ChatRequestBody {
  provider?: Provider;
  modelId?: string;
  apiKey?: string;
  mode?: "fast" | "deep";
  task?: Task;
  context?: string;
  question?: string;
  messages?: IncomingMessage[];
}

function buildUserContent(context: string, question: string): string {
  return [
    "以下是来自用户本地论文的必要文本。",
    context,
    question ? `\n用户请求：${question}` : "\n请按任务要求完成。",
  ].join("\n");
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  onStatus?: (status: number) => void,
): Promise<Response | undefined> {
  let upstream: Response | undefined;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    upstream = await fetch(url, init);
    onStatus?.(upstream.status);
    if (upstream.ok || !RETRYABLE_UPSTREAM_STATUS.has(upstream.status) || attempt === RETRY_BACKOFF_MS.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
  }
  return upstream;
}

function streamOrError(upstream: Response | undefined, label: string, upstreamStatus = 0): Response {
  if (!upstream || !upstream.ok || !upstream.body) {
    const status = upstreamStatus || 502;
    const reason =
      status === 429
        ? "（上游并发/速率限制，已自动重试多次仍失败，请稍等约 20 秒后再试）"
        : status === 401
          ? "（API Key 无效或已失效）"
          : "";
    return NextResponse.json(
      { error: `${label} 请求失败（HTTP ${status}）${reason}，请检查 Key、额度和网络。` },
      { status: status || 502, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new Response(sseTextStream(upstream.body), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform" },
  });
}

/** 自定义模型请求：地址、模型名、Key、参数全部来自设置中的模型配置。 */
async function handleCustomRequest(
  config: CustomModelConfig,
  body: ChatRequestBody,
): Promise<Response> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: `请先在设置中为「${config.name}」配置 API Key。` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const task = body.task ?? "free";
  const mode = body.mode === "deep" ? "deep" : "fast";
  const context = body.context?.slice(0, 160000) ?? "";
  const question = body.question?.slice(0, 12000) ?? "";
  const messages = (body.messages ?? []).slice(-12).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 160000),
  }));
  if (!question && !context) {
    return NextResponse.json({ error: "没有可供分析的论文内容。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const instructions = loadTaskInstructions();
  const systemPrompt = loadSystemPrompt();
  // stream 与 messages 由服务端强制，用户配置的 params 无法覆盖。
  const upstreamBody = {
    model: config.model,
    stream: true,
    ...(config.params ?? {}),
    ...(mode === "deep" ? config.deepParams ?? {} : {}),
    messages: [
      { role: "system", content: `${systemPrompt}\n\n任务要求：\n${instructions[task]}` },
      ...messages,
      { role: "user", content: buildUserContent(context, question) },
    ],
  };
  let upstreamStatus = 0;
  try {
    const upstream = await requestWithRetry(
      config.baseUrl,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(upstreamBody),
      },
      (status) => {
        upstreamStatus = status;
      },
    );
    return streamOrError(upstream, config.name, upstreamStatus);
  } catch {
    return NextResponse.json({ error: `无法连接 ${config.name}，请检查请求地址与网络后重试。` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequestBody;

  // 自定义模型：modelId 命中自定义配置时按模型配置请求（内置模型路径不受影响）。
  const resolved: ResolvedModel | undefined = resolveModel(body.modelId);
  if (resolved?.kind === "custom") {
    return handleCustomRequest(resolved.config, body);
  }

  // 模型按前端下拉的 modelId 精确选择（4 个模型互不干扰）；
  // 兼容旧调用方：无 modelId 时按 provider + mode 推导。
  const picked = body.modelId ? modelById[body.modelId] : undefined;
  const provider: Provider = picked?.provider ?? (body.provider === "glm" ? "glm" : body.provider === "kimi" ? "kimi" : "deepseek");
  const target = providerTargets[provider];
  // API Key 直接从本机 data/apikey.txt 读取，浏览器不再随请求发送密钥；
  // 兼容旧调用方：请求体里的 apiKey 作为兜底。
  const apiKey = readApiKeyFile()[provider]?.trim() || body.apiKey?.trim();
  const task = body.task ?? "free";
  const mode = body.mode === "deep" ? "deep" : "fast";
  const context = body.context?.slice(0, 160000) ?? "";
  const question = body.question?.slice(0, 12000) ?? "";
  const messages = (body.messages ?? []).slice(-12).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 160000),
  }));

  if (!apiKey) return NextResponse.json({ error: `请先在设置中输入${target.label} API Key。` }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!question && !context) return NextResponse.json({ error: "没有可供分析的论文内容。" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  // 提示词来自项目 public/prompts.txt（可随时编辑，缺失任务回退内置默认）；
  // [system] 为基础系统提示词（"你是一个论文阅读助手"人设）。
  const instructions = loadTaskInstructions();
  const systemPrompt = loadSystemPrompt();

  let upstreamStatus = 0;
  try {
    // 快速/深度只切换 thinking（非思考/思考），不再更换模型：
    // 模型 = modelId 对应的模型（旧调用方按 provider+mode 推导），404 时走回退候选。
    const baseModel = picked?.model ?? (provider === "glm" && mode === "deep" ? target.fallbackModels?.[0] ?? target.model : target.model);
    const models = [baseModel, ...(picked?.fallbackModels ?? target.fallbackModels ?? [])].filter(
      (model, index, list) => model && list.indexOf(model) === index,
    );
    let upstream: Response | undefined;
    for (const model of models) {
      let modelStatus = 0;
      upstream = await requestWithRetry(
        target.url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            model,
            stream: true,
            // 快速/深度 = 非思考/思考：所有模型统一发送 thinking 开关（GLM 双档实测均支持）
            thinking: { type: mode === "deep" ? "enabled" : "disabled" },
            ...(provider === "deepseek" && mode === "deep" ? { reasoning_effort: "max" } : {}),
            messages: [
              {
                role: "system",
                content: `${systemPrompt}\n\n任务要求：\n${instructions[task]}`,
              },
              ...messages,
              { role: "user", content: buildUserContent(context, question) },
            ],
          }),
        },
        (status) => {
          modelStatus = status;
          upstreamStatus = status;
        },
      );
      if (upstream?.ok) break;
      // 404 通常是“模型不存在/无权限”：换下一个候选模型重试；其他错误码不再换模型。
      if (modelStatus !== 404 || model === models[models.length - 1]) break;
    }
    return streamOrError(upstream, target.label, upstreamStatus);
  } catch {
    return NextResponse.json({ error: `无法连接 ${target.label}，请稍后重试。` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
