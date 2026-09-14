/**
 * /api/updates 的同源校验（纯函数，便于单测）。
 *
 * 这个接口会停下来替换本地安装、启动进程，必须挡住浏览器里的跨站页面，同时不能挡住应用自己。
 *
 * 两个实测踩过的坑（Chrome + next start + Next 15，2026-09）：
 * 1. **不能强制要求 Origin 存在**——浏览器对同源 POST 有时不带它；早先的实现要求
 *    `Origin` 必须存在且相等，把应用自己的检测/下载/安装请求全挡成了 403。
 * 2. **不能拿 `request.url` 的 origin 去比**——Next 在 Route Handler 里会把 host
 *    规范化（实测请求打到 127.0.0.1:3000，而 `url.origin` 是 http://localhost:3000），
 *    于是浏览器的 `Origin: http://127.0.0.1:3000` 永远对不上，同样 403。
 *    改为与原始 `Host` 头比对：它是浏览器真正连接的地址，Next 改不了。
 *
 * 最终规则：
 * - 请求必须落在本机回环地址；
 * - `Sec-Fetch-Site` 存在时必须是 same-origin / none（浏览器标注的跨站请求直接拒绝）；
 * - `Origin` 存在时必须指向本机，且其 host:port 与 `Host` 头一致（跨站页面无法伪造这一项）；
 * - 两者都缺失时（curl 等非浏览器客户端）放行——浏览器威胁模型下不存在这种请求，
 *   而本机进程本来就能直接读 data/ 目录，不构成额外暴露面。
 */
interface UpdateRequestSignals {
  /** 请求头 origin（可能是 null）。 */
  origin: string | null;
  /** 请求头 sec-fetch-site（可能是 null）。 */
  secFetchSite: string | null;
  /** 请求自身的 origin，仅在缺少 Host 头时作为兜底。 */
  requestOrigin: string;
  /** 原始 Host 头，例如 127.0.0.1:3000。 */
  host: string | null;
  /** 请求自身的 hostname。 */
  hostname: string;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

export function isTrustedUpdateRequest(signals: UpdateRequestSignals): boolean {
  if (!isLoopback(signals.hostname)) return false;

  const site = signals.secFetchSite?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = signals.origin?.trim();
  if (origin) {
    // 某些浏览器场景会把 Origin 置为字符串 "null"（沙箱 iframe 等），一律拒绝。
    if (origin.toLowerCase() === "null") return false;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (!isLoopback(parsed.hostname)) return false;
    let expected: string;
    try {
      expected = (signals.host || new URL(signals.requestOrigin).host).toLowerCase();
    } catch {
      return false;
    }
    if (parsed.host.toLowerCase() !== expected) return false;
  }

  return true;
}
