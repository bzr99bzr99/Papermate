import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { emptyBackup, isBackup, type PaperMateBackup } from "@/lib/backup";
import { getDefaultStorage, writeBackupFile } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const backupFile = () => path.join(process.cwd(), "data", "papermate-backup.json");

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const full = new URL(request.url).searchParams.get("full") === "1";
  try {
    if (!existsSync(backupFile())) {
      return NextResponse.json(
        { ok: false, filePath: backupFile(), error: "本机备份文件不存在。" },
        { status: 404, headers: noStore },
      );
    }
    const raw = await readFile(backupFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isBackup(parsed)) {
      return NextResponse.json(
        { ok: false, filePath: backupFile(), error: "本机备份文件已损坏。" },
        { status: 500, headers: noStore },
      );
    }
    if (full) {
      return NextResponse.json(
        { ok: true, filePath: backupFile(), ...parsed },
        { headers: noStore },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        filePath: backupFile(),
        savedAt: parsed.savedAt,
        paperCount: parsed.papers.length,
        workspaceCount: parsed.workspaces.length,
      },
      { headers: noStore },
    );
  } catch {
    const empty = emptyBackup();
    if (full) {
      return NextResponse.json(
        { ok: true, filePath: backupFile(), ...empty },
        { headers: noStore },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        filePath: backupFile(),
        savedAt: undefined,
        paperCount: 0,
        workspaceCount: 0,
      },
      { headers: noStore },
    );
  }
}

export async function POST(request: Request) {
  try {
    const text = await request.text();
    let backup: PaperMateBackup;
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      if (!isBackup(parsed)) {
        return NextResponse.json(
          { error: "备份格式无效。" },
          { status: 400, headers: noStore },
        );
      }
      backup = parsed;
    } else {
      backup = getDefaultStorage().buildBackup();
    }
    const savedAt = new Date().toISOString();
    writeBackupFile({ ...backup, savedAt }, backupFile());
    return NextResponse.json(
      { ok: true, savedAt, filePath: backupFile() },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法写入本机备份，请检查磁盘空间或读写权限。" },
      { status: 500, headers: noStore },
    );
  }
}
