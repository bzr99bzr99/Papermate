import { NextResponse } from "next/server";
import { readApiKeyFile } from "@/lib/api-keys";
import { readWebSearchConfig, writeWebSearchConfig } from "@/lib/web-search-store";
import {
  toWebSearchConfigView,
  validateWebSearchConfig,
  type WebSearchConfig,
} from "@/lib/web-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 联网搜索配置读写（设置页用）。与 /api/storage/models 同模式：GET 脱敏，绝不回传明文 Key。 */

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const config = readWebSearchConfig();
    const glmKey = readApiKeyFile().glm;
    return NextResponse.json({ config: toWebSearchConfigView(config, glmKey) }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "无法读取联网搜索配置。" }, { status: 500, headers: noStore });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { config?: Record<string, unknown> };
    const result = validateWebSearchConfig(body.config ?? {});
    if (!result.ok) {
      return NextResponse.json({ error: result.errors.join(" ") }, { status: 400, headers: noStore });
    }
    const next: WebSearchConfig = { ...result.value };
    if (result.value.apiKey === undefined) {
      // 表单留空 = 保持已保存的 Key 不变；显式传空字符串才是清空。
      const stored = readWebSearchConfig().apiKey?.trim();
      if (stored) next.apiKey = stored;
      else delete next.apiKey;
    }
    writeWebSearchConfig(next);
    return NextResponse.json(
      { ok: true, config: toWebSearchConfigView(next, readApiKeyFile().glm) },
      { headers: noStore },
    );
  } catch {
    return NextResponse.json({ error: "联网搜索配置保存失败，请检查磁盘写入权限。" }, { status: 500, headers: noStore });
  }
}
