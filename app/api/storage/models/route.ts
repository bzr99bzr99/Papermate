import { NextResponse } from "next/server";
import {
  getAllModelOptions,
  readCustomModels,
  resolveModel,
  writeCustomModels,
} from "@/lib/models-store";
import {
  MAX_CUSTOM_MODELS,
  validateCustomModel,
  type CustomModelConfig,
} from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** 自定义模型配置（设置页编辑用；与 /api/storage/apikey 同模式，本机明文）。 */
export async function GET() {
  try {
    return NextResponse.json(
      { models: getAllModelOptions(), custom: readCustomModels() },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json(
      { error: "无法读取自定义模型配置。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { model?: Partial<CustomModelConfig> };
    const result = validateCustomModel(body.model ?? {});
    if (!result.ok) {
      return NextResponse.json(
        { error: result.errors.join(" ") },
        { status: 400, headers: noStore },
      );
    }
    const next = result.value;
    const current = readCustomModels();
    const exists = current.some((item) => item.id === next.id);
    if (!exists && current.length >= MAX_CUSTOM_MODELS) {
      return NextResponse.json(
        { error: `自定义模型数量已达上限（${MAX_CUSTOM_MODELS} 个），请先删除不需要的模型。` },
        { status: 400, headers: noStore },
      );
    }
    const saved = exists
      ? current.map((item) => (item.id === next.id ? next : item))
      : [...current, next];
    writeCustomModels(saved);
    return NextResponse.json({ ok: true, model: next }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "自定义模型保存失败，请检查磁盘写入权限。" },
      { status: 500, headers: noStore },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    const id = body.id?.trim();
    if (!id) {
      return NextResponse.json({ error: "缺少模型 id。" }, { status: 400, headers: noStore });
    }
    // 内置模型不可删除。
    if (resolveModel(id)?.kind === "builtin") {
      return NextResponse.json(
        { error: "内置模型不可删除。" },
        { status: 400, headers: noStore },
      );
    }
    const current = readCustomModels();
    if (!current.some((item) => item.id === id)) {
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    writeCustomModels(current.filter((item) => item.id !== id));
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "自定义模型删除失败，请检查磁盘写入权限。" },
      { status: 500, headers: noStore },
    );
  }
}
