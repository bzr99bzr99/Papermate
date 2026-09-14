import { checkUpdate, beginDownload, installUpdate, updateStatus } from "@/lib/updater";
import { isTrustedUpdateRequest } from "@/lib/update-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(updateStatus(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * 会改动本机安装的写操作：只接受本机同源请求。
 * 判定细节与实测教训见 lib/update-guard.ts —— 浏览器对同源 POST 不一定发送 Origin，
 * 早先「强制要求 Origin 匹配」的写法把应用自己的检测/下载/安装请求全部挡成了 403。
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  if (!isTrustedUpdateRequest({
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    requestOrigin: url.origin,
    host: request.headers.get("host"),
    hostname: url.hostname,
  })) {
    return Response.json({ message: "不允许跨站更新请求" }, { status: 403 });
  }
  try {
    const { action, manual } = await request.json();
    // manual：用户手动点「检查更新」时跳过自动检测的最小间隔限制。
    if (action === "check") return Response.json(await checkUpdate({ manual: manual === true }));
    if (action === "download") return Response.json(beginDownload());
    if (action === "install") return Response.json(installUpdate());
    return Response.json({ message: "未知更新操作" }, { status: 400 });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "更新失败" }, { status: 409 });
  }
}
