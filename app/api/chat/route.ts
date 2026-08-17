import { NextResponse } from "next/server";
import { loadSystemPrompt, loadTaskInstructions, type Task } from "@/lib/prompts";
import { readApiKeyFile } from "@/lib/api-keys";

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
    model: "glm-4.7-flash",
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

export async function POST(request: Request) {
  const body = (await request.json()) as {
    provider?: Provider;
    apiKey?: string;
    mode?: "fast" | "deep";
    task?: Task;
    context?: string;
    question?: string;
    messages?: IncomingMessage[];
  };
  const provider = body.provider === "glm" ? "glm" : body.provider === "kimi" ? "kimi" : "deepseek";
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

  const userContent = [
    "以下是来自用户本地论文的必要文本。",
    context,
    question ? `\n用户请求：${question}` : "\n请按任务要求完成。",
  ].join("\n");

  // 提示词来自项目 public/prompts.txt（可随时编辑，缺失任务回退内置默认）；
  // [system] 为基础系统提示词（"你是一个论文阅读助手"人设）。
  const instructions = loadTaskInstructions();
  const systemPrompt = loadSystemPrompt();

  // GLM 免费档等上游对 429 限流有较长的冷却窗口（实测约 12-20 秒），
  // 这里在返回错误前用递增退避重试，覆盖冷却期后直接开始流式输出。
  const RETRYABLE_UPSTREAM_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  const RETRY_BACKOFF_MS = [3000, 7000, 13000];
  try {
    const models = [target.model, ...(target.fallbackModels ?? [])];
    let upstream: Response | undefined;
    let upstreamStatus = 0;
    for (const model of models) {
      let modelStatus = 0;
      for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
        upstream = await fetch(target.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            model,
            stream: true,
            ...(provider === "deepseek" || provider === "kimi"
              ? {
                  thinking: { type: mode === "deep" ? "enabled" : "disabled" },
                  ...(provider === "deepseek" && mode === "deep" ? { reasoning_effort: "max" } : {}),
                }
              : {}),
            messages: [
              {
                role: "system",
                content: `${systemPrompt}\n\n任务要求：\n${instructions[task]}`,
              },
              ...messages,
              { role: "user", content: userContent },
            ],
          }),
        });
        modelStatus = upstream.status;
        upstreamStatus = modelStatus;
        if (
          upstream.ok ||
          !RETRYABLE_UPSTREAM_STATUS.has(modelStatus) ||
          attempt === RETRY_BACKOFF_MS.length
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
      }
      if (upstream?.ok) break;
      // 404 通常是“模型不存在/无权限”：换下一个候选模型重试；其他错误码不再换模型。
      if (modelStatus !== 404 || model === models[models.length - 1]) break;
    }
  if (!upstream || !upstream.ok || !upstream.body) {
    const status = upstreamStatus || 502;
    const reason =
      status === 429
        ? "（上游并发/速率限制，已自动重试多次仍失败，请稍等约 20 秒后再试）"
        : status === 401
          ? "（API Key 无效或已失效）"
          : "";
    return NextResponse.json({ error: `${target.label} 请求失败（HTTP ${status}）${reason}，请检查 Key、额度和网络。` }, { status: status || 502, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(sseTextStream(upstream.body), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform" },
  });
  } catch {
    return NextResponse.json({ error: `无法连接 ${target.label}，请稍后重试。` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
