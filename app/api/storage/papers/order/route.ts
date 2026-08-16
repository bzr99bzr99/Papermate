import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      return NextResponse.json(
        { error: "排序数据格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    getDefaultStorage().reorderPapers(body.ids as string[]);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "保存排序失败。" },
      { status: 500, headers: noStore },
    );
  }
}
