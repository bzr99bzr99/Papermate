import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Provider = "deepseek" | "glm";

export async function POST(request: Request) {
  const body = (await request.json()) as { provider?: Provider; apiKey?: string };
  const provider = body.provider === "glm" ? "glm" : "deepseek";
  const apiKey = body.apiKey?.trim();
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
              model: "glm-4.7-flash",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
              stream: false,
            }),
          })
        : await fetch("https://api.deepseek.com/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
            cache: "no-store",
          });
    if (!upstream.ok) {
      return NextResponse.json({ error: "API Key 无效或当前不可用。" }, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "无法连接模型服务，请检查网络后重试。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
