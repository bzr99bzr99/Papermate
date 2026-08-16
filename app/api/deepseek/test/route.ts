import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { apiKey } = (await request.json()) as { apiKey?: string };
  if (!apiKey?.trim()) {
    return NextResponse.json({ error: "请先输入 DeepSeek API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const upstream = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      cache: "no-store",
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: "API Key 无效或当前不可用。" }, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "无法连接 DeepSeek，请检查网络后重试。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
