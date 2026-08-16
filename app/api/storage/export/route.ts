import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return NextResponse.json(getDefaultStorage().buildBackup(), { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "导出备份失败。" },
      { status: 500, headers: noStore },
    );
  }
}
