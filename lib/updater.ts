import { lockForUpdate, unlockUpdate } from "./update-activity";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, copyFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { version } from "../package.json";
import {
  isNewerVersion,
  latestReleasePageUrl,
  newestFromAtom,
  parseReleaseTagFromUrl,
  parseReleasesAtom,
  parseVersion,
  releasesAtomUrl,
  trustedAsset,
  UPDATE_ASSET,
  UPDATE_CHECKSUM_ASSET,
  UPDATE_VERSION_ASSET,
  UPDATE_REPOSITORY,
} from "./update-version";
import { UPDATE_ACTIVE_PHASES, type UpdateStatus } from "./update-types";

/**
 * 自动更新（仅 Windows x64 正式安装副本）：
 * 检测 GitHub 正式 Release → 下载预构建包并用 SHA-256 校验 → 独立 PowerShell 助手停止服务、
 * 备份旧程序、替换文件、健康检查、失败回滚。用户数据（data/、自定义提示词）全程保留。
 *
 * 版本发现刻意**不走 api.github.com**：未登录的 API 每小时只有 60 次，共享出口 IP 时
 * 极易耗尽，用户会看到「调用次数已用完」而完全无法更新。改用 github.com 的普通网页路径：
 *   - /releases/latest 的跳转（最终 URL 里带 tag），「最新」语义与 API 一致（排除草稿/预发布）
 *   - /releases.atom 订阅源（拿更新说明，同样不限流）
 * API 只作为最后的兜底。
 *
 * 源码目录（有 .git 或未登记为 installedCopy）只提供检测与版本提示，不做覆盖安装。
 */

/** 安装阶段超过这个时间没有新状态，就认为更新助手已经中断（正常安装约 1-2 分钟）。 */
const INSTALL_STALE_MS = 20 * 60 * 1000;
/** 更新包大小上限，防御异常/恶意 Release 附件。 */
const MAX_ARCHIVE_BYTES = 1500 * 1024 * 1024;
/** 自动检测的最小间隔；用户手动点「检查更新」不受限制。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 指纹与说明文本的长度上限。 */
const NOTES_LIMIT = 12000;

/**
 * 状态与任务文件统一带 UTF-8 BOM。
 * 原因：apply-update.ps1 由 Windows PowerShell 5.1 执行，它的 `Get-Content` 默认按系统
 * ANSI 代码页解码；没有 BOM 时，只要安装路径含中文（例如 D:\论文助手），读出来的路径
 * 就是乱码，更新会在第一步直接失败。带 BOM 时 5.1 会正确识别为 UTF-8。
 * 读取侧（本文件的 readPersisted / openJob）都会剥掉 BOM。
 */
const UTF8_BOM = "\uFEFF";

function installConfig() {
  const appData = process.env.PAPERMATE_APP_DATA || path.join(process.env.LOCALAPPDATA || "", "PaperMate");
  try {
    const config = JSON.parse(readFileSync(path.join(appData, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    if (process.platform !== "win32" || process.arch !== "x64" || !config.installedCopy || existsSync(path.join(process.cwd(), ".git"))
      || path.resolve(config.projectDir).toLowerCase() !== path.resolve(process.cwd()).toLowerCase()) return undefined;
    return { appData: path.resolve(appData), config };
  } catch { return undefined; }
}

function root() { const config = installConfig(); return config ? path.join(config.appData, "updates") : undefined; }
function statePath() { const dir = root(); return dir ? path.join(dir, "status.json") : undefined; }
function lockPath() { const dir = root(); return dir ? path.join(dir, "lock") : undefined; }

let memory: UpdateStatus = { currentVersion: version, supported: false, phase: "idle" };

function readPersisted(): UpdateStatus | undefined {
  const file = statePath();
  if (!file || !existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as UpdateStatus; } catch { return undefined; }
}

function persist(status: UpdateStatus) {
  const file = statePath();
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, UTF8_BOM + JSON.stringify(status));
  renameSync(temp, file);
}

function withEnv(status: UpdateStatus): UpdateStatus {
  return { ...status, currentVersion: version, supported: Boolean(installConfig()) };
}

function removeLock() {
  const file = lockPath();
  if (!file) return;
  try { unlinkSync(file); } catch { /* 没有锁就无需处理 */ }
}

/**
 * 上一次会话异常退出留下的中间状态自恢复（断电、关窗口、更新助手被杀）：
 * - `downloading` 且不是本进程发起的 → 下载已被中断，重置为 idle 并清掉残留锁；
 * - `installing` 且超过 INSTALL_STALE_MS 没有新状态 → 更新助手已中断，转成 error 让用户重来。
 * 没有这层恢复，用户会永久停在“正在下载/正在安装”，而且再也点不动更新按钮。
 */
function recoverStale(status: UpdateStatus): { status: UpdateStatus; changed: boolean } {
  const now = Date.now();
  if (status.phase === "downloading" && status.ownerPid !== process.pid) {
    removeLock();
    return {
      changed: true,
      status: { ...status, phase: "idle", progress: undefined, message: "上次下载已中断，请重新检测更新。", updatedAt: now, ownerPid: process.pid },
    };
  }
  if (status.phase === "installing" && status.updatedAt && now - status.updatedAt > INSTALL_STALE_MS) {
    removeLock();
    return {
      changed: true,
      status: { ...status, phase: "error", message: "更新程序似乎已中断，请用桌面快捷方式重新启动后再试。", updatedAt: now, ownerPid: process.pid },
    };
  }
  return { status, changed: false };
}

export function updateStatus(): UpdateStatus {
  const persisted = readPersisted();
  if (persisted) memory = persisted;
  const recovered = recoverStale(memory);
  memory = recovered.changed ? withEnv(recovered.status) : recovered.status;
  if (recovered.changed) persist(memory);
  return withEnv(memory);
}

function setState(patch: Partial<UpdateStatus>) {
  const persisted = readPersisted();
  if (persisted) memory = persisted;
  memory = withEnv({ ...memory, ...patch, updatedAt: Date.now(), ownerPid: process.pid });
  persist(memory);
  return memory;
}

interface LatestRelease {
  tag: string;
  /** 更新说明（纯文本），可能为空——只有确实有新版本时才会去取。 */
  notes?: string;
  pageUrl?: string;
}

const GITHUB_PAGE_HEADERS = { "User-Agent": "PaperMate-Updater", Accept: "text/html,application/atom+xml,*/*" };

/** 主路径：跟随 /releases/latest 的跳转，从最终 URL 读出 tag。不受 API 限流约束。 */
async function latestViaReleasePage(): Promise<LatestRelease | undefined> {
  try {
    const response = await fetch(latestReleasePageUrl(), {
      redirect: "follow",
      headers: GITHUB_PAGE_HEADERS,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const tag = parseReleaseTagFromUrl(response.url);
    if (!tag || !parseVersion(tag)) return undefined;
    return { tag, pageUrl: response.url };
  } catch {
    return undefined;
  }
}

/** 备选：Release Atom 订阅源（顺带能拿到更新说明），同样不受 API 限流约束。 */
async function latestViaAtom(): Promise<LatestRelease | undefined> {
  try {
    const response = await fetch(releasesAtomUrl(), {
      headers: GITHUB_PAGE_HEADERS,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const newest = newestFromAtom(await response.text());
    if (!newest) return undefined;
    return { tag: newest.tag, notes: newest.notes.slice(0, NOTES_LIMIT) || undefined, pageUrl: newest.url };
  } catch {
    return undefined;
  }
}

/** 兜底：官方 API。未登录时每小时只有 60 次，容易 403，所以只在前两条都失败时才用。 */
async function latestViaApi(): Promise<LatestRelease | undefined> {
  const response = await fetch("https://api.github.com/repos/" + UPDATE_REPOSITORY + "/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PaperMate-Updater", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000), cache: "no-store",
  });
  if (response.status === 404) return undefined;
  // 403/429 基本都是未登录配额用完；这与“检测失败”要分清楚，且绝不能当成“已是最新版”。
  if (response.status === 403 || response.status === 429) {
    const limited = response.headers.get("x-ratelimit-limit") !== null || response.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(limited
      ? "GitHub 接口调用次数已用完（未登录每小时 60 次），请稍后再试。"
      : "GitHub 拒绝了检测请求（HTTP " + response.status + "），请稍后重试。");
  }
  if (!response.ok) throw new Error("GitHub 检测失败（HTTP " + response.status + "），请稍后重试。");
  const release = await response.json() as {
    tag_name: string; draft: boolean; prerelease: boolean; body?: string; html_url?: string;
  };
  if (release.draft || release.prerelease) throw new Error("最新版本是草稿或预发布版本，已忽略。");
  if (!parseVersion(release.tag_name)) throw new Error("最新正式版本的版本号格式不受支持：" + release.tag_name);
  return { tag: release.tag_name, notes: release.body?.slice(0, NOTES_LIMIT), pageUrl: release.html_url };
}

/** 只认正式 Release：草稿与预发布一律忽略。API 路径的「最新」语义，网页跳转与它一致。 */
async function latest(): Promise<LatestRelease | undefined> {
  return (await latestViaReleasePage()) ?? (await latestViaAtom()) ?? (await latestViaApi());
}

/** 取某个 tag 的更新说明（只在确实有新版本时调用一次，走订阅源，不限流）。 */
async function notesFor(tag: string): Promise<string | undefined> {
  try {
    const response = await fetch(releasesAtomUrl(), {
      headers: GITHUB_PAGE_HEADERS,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const normalized = tag.replace(/^v/, "");
    const release = parseReleasesAtom(await response.text())
      .find((item) => item.tag.replace(/^v/, "") === normalized);
    return release?.notes.slice(0, NOTES_LIMIT) || undefined;
  } catch {
    return undefined;
  }
}

export async function checkUpdate(options: { manual?: boolean } = {}) {
  const current = updateStatus();
  if (UPDATE_ACTIVE_PHASES.includes(current.phase)) return current;
  // 自动检测限频：每次打开页面都发一次请求既没必要，也是撞上 GitHub 限流的主因。
  // 手动点「检查更新」永远实际执行。
  if (!options.manual && current.checkedAt && Date.now() - current.checkedAt < AUTO_CHECK_INTERVAL_MS) return current;
  setState({ phase: "checking", message: undefined });
  try {
    const release = await latest();
    const newer = Boolean(release && isNewerVersion(release.tag, version));
    // 更新说明只在确实有新版本时展示，避免“已是最新”时还挂着一大段旧公告。
    const notes = newer ? release?.notes ?? (await notesFor(release!.tag)) : undefined;
    return setState({
      phase: newer ? "available" : "idle",
      latestVersion: release?.tag,
      notes,
      releaseUrl: release?.pageUrl
        ?? (release ? "https://github.com/" + UPDATE_REPOSITORY + "/releases/tag/" + encodeURIComponent(release.tag) : undefined),
      progress: undefined,
      checkedAt: Date.now(),
      message: newer ? "发现新版本 " + release?.tag : release ? "当前已是最新正式版本" : "仓库尚未发布正式版本",
    });
  } catch (error) {
    // 检测失败必须是明确的错误：清掉上一次的版本信息，不能显示成“已经是最新版”。
    return setState({
      phase: "error",
      latestVersion: undefined,
      notes: undefined,
      releaseUrl: undefined,
      progress: undefined,
      checkedAt: Date.now(),
      message: error instanceof Error ? error.message : "检测更新失败",
    });
  }
}

/** 取锁；EEXIST 说明有残留锁——状态不在进行中时按上次崩溃的遗留处理，否则用户会永远无法更新。 */
function acquireLock(dir: string) {
  const file = path.join(dir, "lock");
  try {
    closeSync(openSync(file, "wx"));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    removeLock();
    closeSync(openSync(file, "wx"));
  }
}

export function beginDownload() {
  const dir = root();
  if (!dir) throw new Error("自动安装仅支持正式安装的 Windows x64 版本。");
  mkdirSync(dir, { recursive: true });
  const status = updateStatus();
  if (UPDATE_ACTIVE_PHASES.includes(status.phase)) return status;
  acquireLock(dir);
  setState({ phase: "downloading", progress: 0, message: "正在获取更新包" });
  void download(dir).catch((error) => {
    setState({ phase: "error", progress: undefined, message: String(error?.message || error) });
    removeLock();
  });
  return updateStatus();
}

async function download(dir: string) {
  const release = await latest();
  if (!release || !isNewerVersion(release.tag, version)) throw new Error("没有可安装的新版本。");
  // 附件地址按 tag 直接构造（GitHub 的固定形状），同样不消耗 API 配额。
  const base = "https://github.com/" + UPDATE_REPOSITORY + "/releases/download/" + encodeURIComponent(release.tag);
  const assetUrl = base + "/" + UPDATE_ASSET;
  const checksumUrl = base + "/" + UPDATE_CHECKSUM_ASSET;
  if (!trustedAsset(assetUrl) || !trustedAsset(checksumUrl)) throw new Error("更新地址不可信，已中止。");
  const job = path.join(dir, randomUUID());
  mkdirSync(job);
  const sumResponse = await fetch(checksumUrl, { headers: GITHUB_PAGE_HEADERS, signal: AbortSignal.timeout(30000), cache: "no-store" });
  if (sumResponse.status === 404) throw new Error("此 Release 缺少 SHA-256 校验文件，已中止（不会安装未经校验的包）。");
  if (!sumResponse.ok) throw new Error("下载校验文件失败（HTTP " + sumResponse.status + "）。");
  const sum = (await sumResponse.text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(sum)) throw new Error("校验文件无效。");
  const response = await fetch(assetUrl, { headers: GITHUB_PAGE_HEADERS, signal: AbortSignal.timeout(15 * 60 * 1000), cache: "no-store" });
  if (response.status === 404) throw new Error("此 Release 缺少有效的 Windows 更新包。");
  if (!response.ok || !response.body) throw new Error("下载更新包失败（HTTP " + response.status + "）。");
  // 期望大小来自响应头；拿不到时只依赖 SHA-256，不会更松。
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("更新包体积异常，已中止。");
  const archive = path.join(job, "update.zip");
  const handle = await import("node:fs/promises").then((fs) => fs.open(archive, "wx"));
  const hash = createHash("sha256");
  let size = 0;
  let last = -1;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("更新包体积异常，已中止。");
      hash.update(chunk);
      await handle.writeFile(chunk);
      const progress = declared > 0 ? Math.floor(size / declared * 100) : 0;
      if (progress !== last) { last = progress; setState({ progress }); }
    }
  } finally {
    await handle.close();
  }
  if (declared > 0 && size !== declared) {
    // 半截下载（断网/主动中断）会走到这里：宁可什么都不装，也不能把残缺的包交给安装器。
    throw new Error(`更新包大小与 Release 声明不符（期望 ${declared} 字节，实际 ${size} 字节），已中止。`);
  }
  if (hash.digest("hex").toLowerCase() !== sum.toLowerCase()) {
    throw new Error("更新包校验失败，旧版本未改变。");
  }
  const installed = installConfig()!;
  // 版本信息文件是可选资产：有就记录下来，便于失败排查。
  // 必须带 BOM：安装助手是 Windows PowerShell 5.1，按 ANSI 读会把中文安装路径解成乱码。
  writeFileSync(path.join(dir, "job.json"), UTF8_BOM + JSON.stringify({
    archive,
    job,
    appData: installed.appData,
    projectDir: process.cwd(),
    serverPid: process.pid,
    version: release.tag.replace(/^v/, ""),
    tag: release.tag,
    sha256: sum,
    size,
    versionInfo: UPDATE_VERSION_ASSET,
    releaseUrl: release.pageUrl,
    statusPath: statePath(),
    port: installed.config.port,
  }));
  setState({ phase: "ready", latestVersion: release.tag, progress: 100, message: "下载完成，等待保存数据并安装" });
}

export function installUpdate() {
  const dir = root();
  if (!dir || updateStatus().phase !== "ready") throw new Error("更新包尚未就绪。");
  lockForUpdate();
  const helper = path.join(dir, "apply-update.ps1");
  copyFileSync(path.join(process.cwd(), "scripts", "apply-update.ps1"), helper);
  setState({ phase: "installing", message: "正在安装并重启，请勿关闭电脑" });
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-JobFile", path.join(dir, "job.json")],
    { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => { unlockUpdate(); setState({ phase: "error", message: error.message }); removeLock(); });
  child.unref();
  return updateStatus();
}
