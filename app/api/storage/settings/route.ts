import { NextResponse } from "next/server";
import { getDefaultStorage } from "@/lib/storage";
import type { BackupSettings } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function isSettings(value: unknown): value is BackupSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BackupSettings>;
  return (
    (candidate.theme === undefined || typeof candidate.theme === "string") &&
    (candidate.layout === undefined || typeof candidate.layout === "object")
  );
}

export async function GET() {
  try {
    return NextResponse.json(
      { settings: getDefaultStorage().getSettings() },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法读取界面设置。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    if (!isSettings(body)) {
      return NextResponse.json(
        { error: "界面设置格式无效。" },
        { status: 400, headers: noStore },
      );
    }
    getDefaultStorage().saveSettings(body);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "保存界面设置失败。" },
      { status: 500, headers: noStore },
    );
  }
}
