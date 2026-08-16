import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";
import type { PaperWorkspace } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function isWorkspace(value: unknown): value is PaperWorkspace {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PaperWorkspace>;
  return (
    Array.isArray(candidate.annotations) &&
    Array.isArray(candidate.conversations) &&
    Array.isArray(candidate.artifacts)
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  try {
    const { paperId } = await params;
    return NextResponse.json(
      { workspace: getDefaultStorage().getWorkspace(paperId) },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法读取这篇论文的本地成果。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ paperId: string }> },
) {
  try {
    const { paperId } = await params;
    const body = (await request.json()) as unknown;
    if (!isWorkspace(body)) {
      return NextResponse.json(
        { error: "本地成果格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    getDefaultStorage().saveWorkspace(paperId, body);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "保存本地成果失败。" },
      { status: 500, headers: noStore },
    );
  }
}
