import { NextResponse } from "next/server";
import { readApiKeyFile } from "@/lib/api-keys";
import { resolveModel } from "@/lib/models-store";

export const runtime = "nodejs";

type Provider = "deepseek" | "glm" | "kimi";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    provider?: Provider;
    apiKey?: string;
    modelId?: string;
    url?: string;
    modelName?: string;
  };

  const testChatCompletions = async (url: string, model: string, apiKey: string) => {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "连接失败，请检查请求地址、API Key 与模型名。" },
        { status: upstream.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  };

  // 自定义模型（已保存）：用其配置的地址、模型名与 Key 做最小请求测试。
  const resolved = resolveModel(body.modelId);
  if (resolved?.kind === "custom") {
    const config = resolved.config;
    const apiKey = (body.apiKey ?? "").trim() || config.apiKey?.trim() || "";
    if (!apiKey) {
      return NextResponse.json({ error: "请先填写 API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    try {
      return await testChatCompletions(config.baseUrl, config.model, apiKey);
    } catch {
      return NextResponse.json(
        { error: "无法连接模型服务，请检查网络后重试。" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // 未保存的草稿：按表单中的地址 / 模型名 / Key 直接测试。
  if (body.url && body.modelName) {
    const apiKey = (body.apiKey ?? "").trim();
    if (!apiKey) {
      return NextResponse.json({ error: "请先填写 API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    try {
      return await testChatCompletions(body.url, body.modelName, apiKey);
    } catch {
      return NextResponse.json(
        { error: "无法连接模型服务，请检查网络后重试。" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const provider = body.provider === "glm" ? "glm" : body.provider === "kimi" ? "kimi" : "deepseek";
  // 优先测试设置页里刚输入的 Key（body），未提供时使用 data/apikey.txt 中已保存的 Key。
  const apiKey = body.apiKey?.trim() || readApiKeyFile()[provider]?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "请先输入 API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const upstream =
      provider === "glm"
        ? await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              model: "glm-4-flash",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
              stream: false,
            }),
          })
        : await fetch(
            provider === "kimi" ? "https://api.moonshot.cn/v1/models" : "https://api.deepseek.com/models",
            {
              headers: { Authorization: `Bearer ${apiKey}` },
              cache: "no-store",
            },
          );
    if (!upstream.ok) {
      return NextResponse.json({ error: "API Key 无效或当前不可用。" }, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "无法连接模型服务，请检查网络后重试。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
