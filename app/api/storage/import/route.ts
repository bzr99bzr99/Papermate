import { NextResponse } from "next/server";
import { isBackup } from "@/lib/backup";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!isBackup(body)) {
      return NextResponse.json(
        { error: "备份格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    const result = getDefaultStorage().importBackup(body);
    return NextResponse.json({ ok: true, ...result }, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.includes("重复") || message.includes("无效") ? 400 : 500;
    return NextResponse.json(
      { error: message || "导入备份失败。" },
      { status, headers: noStore },
    );
  }
}
