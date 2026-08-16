import { NextResponse } from "next/server";
import { isBackupPaper } from "@/lib/backup";
import { getDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return NextResponse.json(
      { papers: getDefaultStorage().listPaperMetas() },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法读取论文库。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!isBackupPaper(body)) {
      return NextResponse.json(
        { error: "论文数据格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    getDefaultStorage().savePaper(body);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("同源论文")) {
      return NextResponse.json(
        { error: message },
        { status: 409, headers: noStore },
      );
    }
    return NextResponse.json(
      { error: "保存论文失败，请检查磁盘空间或读写权限。" },
      { status: 500, headers: noStore },
    );
  }
}
