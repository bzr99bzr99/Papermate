import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { emptyBackup, isBackup } from "@/lib/backup";

export const runtime = "nodejs";

const backupDirectory = () => path.join(process.cwd(), "data");
const backupFile = () => path.join(backupDirectory(), "papermate-backup.json");

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const raw = await readFile(backupFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isBackup(parsed)) {
      return NextResponse.json(
        { ok: false, filePath: backupFile(), ...emptyBackup() },
        { status: 500, headers: noStore },
      );
    }
    return NextResponse.json({ ok: true, filePath: backupFile(), ...parsed }, { headers: noStore });
  } catch {
    return NextResponse.json({ ok: true, filePath: backupFile(), ...emptyBackup() }, { headers: noStore });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!isBackup(body)) {
      return NextResponse.json({ error: "备份格式无效。" }, { status: 400, headers: noStore });
    }
    const directory = backupDirectory();
    await mkdir(directory, { recursive: true });
    const savedAt = new Date().toISOString();
    const tempFile = path.join(directory, `papermate-backup.${Date.now()}.tmp`);
    await writeFile(tempFile, JSON.stringify({ ...body, savedAt }), "utf8");
    try {
      await rename(tempFile, backupFile());
    } catch {
      await rm(backupFile(), { force: true });
      await rename(tempFile, backupFile());
    }
    return NextResponse.json({ ok: true, savedAt, filePath: backupFile() }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "无法写入本机备份，请检查磁盘空间或读写权限。" },
      { status: 500, headers: noStore },
    );
  }
}
