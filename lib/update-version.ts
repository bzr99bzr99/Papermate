/**
 * 版本与发布来源的纯逻辑（无 node:fs / 无网络），客户端与服务端都能安全导入。
 *
 * 版本号：正式 Release 的历史 tag 有 `v3.6`（两段）也有 `v3.0.1`（三段），
 * 因此这里接受 1-3 段数字并把缺失段补 0，统一按 [major, minor, patch] 比较。
 */

const VERSION_PATTERN = /^v?(0|[1-9]\d{0,3})(?:\.(0|[1-9]\d{0,3}))?(?:\.(0|[1-9]\d{0,3}))?$/;

/** 解析版本号（允许 `v3.6`、`3.6.1`、`v3`）；不合法返回 undefined。 */
export function parseVersion(value: string): number[] | undefined {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : undefined;
}

/** candidate 是否比 current 新；任一无法解析时返回 false（宁可不提示，也不误报）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * 更新来源仓库（与 git remote 一致，GitHub 对旧仓库名做 301 跳转，检测仍然可用）。
 * 注意：仓库从 `Papermatev1.0` 改名为 `Papermate` 后，**附件直链一律使用规范名**，
 * 所以下载地址的信任校验必须同时接受这两个名字，否则真实附件会被判为不可信。
 */
export const UPDATE_REPOSITORY = "bzr99bzr99/Papermatev1.0";
export const UPDATE_REPOSITORY_ALIASES = ["bzr99bzr99/Papermatev1.0", "bzr99bzr99/Papermate"];

/** Windows 预构建更新包的文件名（必须与 .github/workflows/release.yml 产物一致）。 */
export const UPDATE_ASSET = "papermate-windows-x64.zip";
/** 校验文件名（内容为 `<sha256>  <asset>`，与 `gh release create` 上传的一致）。 */
export const UPDATE_CHECKSUM_ASSET = UPDATE_ASSET + ".sha256";
/** 版本信息文件名。 */
export const UPDATE_VERSION_ASSET = "papermate-version.json";

/** 只信任本仓库正式 Release 的 https 直链（防重定向到第三方）。 */
export function trustedAsset(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password) {
      return false;
    }
    const pathname = parsed.pathname.toLowerCase();
    return UPDATE_REPOSITORY_ALIASES.some((repo) =>
      pathname.startsWith("/" + repo.toLowerCase() + "/releases/download/"),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   不走 API 的版本发现
   GitHub 未登录 API 每小时只有 60 次（共享出口 IP 时极易耗尽），而下面两条
   github.com 的普通网页路径不受该限制，且「最新」的语义与 API 的 /releases/latest
   一致（同样排除草稿与预发布）。实测 2026-09：API 返回 403 时这两条仍然 200。
   ------------------------------------------------------------------ */

/** `https://github.com/<repo>/releases/latest`：跟随跳转后可从最终 URL 读出 tag。 */
export function latestReleasePageUrl(repo: string = UPDATE_REPOSITORY): string {
  return `https://github.com/${repo}/releases/latest`;
}

/** 仓库的 Release Atom 订阅源：含每个版本的标题、时间与更新说明。 */
export function releasesAtomUrl(repo: string = UPDATE_REPOSITORY): string {
  return `https://github.com/${repo}/releases.atom`;
}

/** 从跳转后的最终 URL 里取 tag；未发布任何正式版时 GitHub 会停在 /releases，返回 undefined。 */
export function parseReleaseTagFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const match = /\/releases\/tag\/(.+)$/.exec(parsed.pathname);
    if (!match) return undefined;
    const tag = decodeURIComponent(match[1]).trim();
    return tag || undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

/** 把 Atom 内容里的 HTML 转成可读纯文本（更新说明会直接显示在弹窗里）。 */
export function htmlToPlainText(html: string): string {
  const decoded = html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z#0-9]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
  return decoded
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|ul|ol|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface AtomRelease {
  tag: string;
  title: string;
  publishedAt?: string;
  notes: string;
  url?: string;
}

/**
 * 解析 Release Atom 订阅源，返回按出现顺序的全部条目。
 * 调用方负责挑版本号最大的那条：订阅源按时间排序，补丁分支版本可能插在最前面。
 */
export function parseReleasesAtom(xml: string): AtomRelease[] {
  const releases: AtomRelease[] = [];
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const entry of entries) {
    const link = /<link[^>]*href="([^"]+)"/.exec(entry)?.[1];
    const tagFromLink = link ? parseReleaseTagFromUrl(link) : undefined;
    const titleRaw = /<title[^>]*>([\s\S]*?)<\/title>/.exec(entry)?.[1]?.trim();
    const tag = tagFromLink ?? (titleRaw && /^v?\d/.test(titleRaw) ? htmlToPlainText(titleRaw) : undefined);
    if (!tag) continue;
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1];
    const updated = /<updated>([\s\S]*?)<\/updated>/.exec(entry)?.[1]?.trim();
    releases.push({
      tag,
      title: titleRaw ? htmlToPlainText(titleRaw) : tag,
      publishedAt: updated,
      notes: content ? htmlToPlainText(content) : "",
      ...(link ? { url: link } : {}),
    });
  }
  return releases;
}

/** 从订阅源里选出版本号最大的正式版本。 */
export function newestFromAtom(xml: string): AtomRelease | undefined {
  const releases = parseReleasesAtom(xml).filter((release) => parseVersion(release.tag));
  if (!releases.length) return undefined;
  return releases.reduce((best, current) => (isNewerVersion(current.tag, best.tag) ? current : best));
}
