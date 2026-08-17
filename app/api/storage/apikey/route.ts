import { NextResponse } from "next/server";
import {
  readApiKeyFile,
  writeApiKeyFile,
  type ApiKeyPair,
} from "@/lib/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return NextResponse.json(readApiKeyFile(), { headers: noStore });
  } catch {
    return NextResponse.json({}, { headers: noStore });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ApiKeyPair;
    const current = readApiKeyFile();
    const merged: ApiKeyPair = {};
    for (const key of ["deepseek", "glm", "kimi"] as const) {
      const value = typeof body[key] === "string" ? body[key]!.trim() : (current[key] ?? "");
      if (value) merged[key] = value;
    }
    writeApiKeyFile(merged);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "API Key 保存失败，请检查磁盘写入权限。" },
      { status: 500, headers: noStore },
    );
  }
}
