import { NextResponse } from "next/server";
import { taskInstructions, type Task } from "@/lib/prompts";

export const runtime = "nodejs";

type IncomingMessage = { role: "user" | "assistant"; content: string };
type Provider = "deepseek" | "glm";

const providerTargets: Record<Provider, { url: string; model: string; label: string }> = {
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
  const provider = body.provider === "glm" ? "glm" : "deepseek";
  const target = providerTargets[provider];
  const apiKey = body.apiKey?.trim();
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

  try {
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        model: target.model,
        stream: true,
        ...(provider === "deepseek"
          ? {
              thinking: { type: mode === "deep" ? "enabled" : "disabled" },
              ...(mode === "deep" ? { reasoning_effort: "max" } : {}),
            }
          : {}),
        messages: [
          {
            role: "system",
            content: `你是严谨的计算机科学与技术领域的论文阅读助手，默认用中文回答。${taskInstructions[task]} 不暴露或复述模型内部思考过程。`,
          },
          ...messages,
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `${target.label} 请求失败，请检查 Key、额度和网络。` }, { status: upstream.status || 502, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(sseTextStream(upstream.body), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform" },
    });
  } catch {
    return NextResponse.json({ error: `无法连接 ${target.label}，请稍后重试。` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
