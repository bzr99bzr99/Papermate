import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  try {
    const { hash } = await params;
    return NextResponse.json(
      { paper: getDefaultStorage().findPaperBySourceHash(hash) ?? null },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法按哈希查找论文。" },
      { status: 500, headers: noStore },
    );
  }
}
