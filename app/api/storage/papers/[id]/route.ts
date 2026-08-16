import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json(
      { paper: getDefaultStorage().getPaper(id) ?? null },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法读取这篇论文。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { note?: unknown; pinned?: unknown };
    if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
      return NextResponse.json(
        { error: "置顶状态格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return NextResponse.json(
        { error: "备注格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    const storage = getDefaultStorage();
    if (body.note !== undefined) storage.updatePaperNote(id, body.note);
    if (body.pinned !== undefined) storage.setPaperPinned(id, body.pinned);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "保存失败。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    getDefaultStorage().deletePaper(id);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "删除论文失败。" },
      { status: 500, headers: noStore },
    );
  }
}
