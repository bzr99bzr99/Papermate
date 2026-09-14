import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../package.json";
import { beginDownload, checkUpdate, installUpdate, updateStatus } from "./updater";
import { UPDATE_ASSET, UPDATE_CHECKSUM_ASSET, releasesAtomUrl } from "./update-version";
import { lockForUpdate, unlockUpdate, beginModelRequest } from "./update-activity";

let appData = "";
let installDir = "";
let previousEnv: string | undefined;

/**
 * 自动更新只支持 Windows x64 的正式安装副本（见 lib/updater.ts 的 supported 判定），
 * 因此整个文件在其它平台跳过：这些用例断言的是 Windows 专属的行为与路径语义，
 * 在 Linux/macOS 上失败只代表平台不符，不代表代码回归。
 * CI 的 windows-latest 分支会完整运行它们（见 .github/workflows/ci.yml）。
 */
const WINDOWS_X64 = process.platform === "win32" && process.arch === "x64";

const originalCwd = process.cwd();
const updatesDir = () => path.join(appData, "updates");
const statusFile = () => path.join(updatesDir(), "status.json");
const lockFile = () => path.join(updatesDir(), "lock");

function writeInstallConfig() {
  writeFileSync(path.join(appData, "config.json"), JSON.stringify({
    appName: "PaperMate",
    projectDir: process.cwd(),
    installedCopy: true,
    port: 3000,
  }), "utf8");
}

/** 读取带 UTF-8 BOM 的 JSON（与生产读取路径一致：先剥 BOM 再解析）。 */
function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
}

function writeStatus(patch: Record<string, unknown>) {
  mkdirSync(updatesDir(), { recursive: true });
  writeFileSync(statusFile(), JSON.stringify({ currentVersion: version, supported: true, phase: "idle", ...patch }), "utf8");
}

const readStatus = () => readJson(statusFile());
const hasBom = (file: string) => {
  const bytes = readFileSync(file);
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
};

const REPO = "bzr99bzr99/Papermatev1.0";
const CANONICAL = "bzr99bzr99/Papermate";
const downloadBase = (tag: string) => `https://github.com/${REPO}/releases/download/${tag}`;

/** 造一个 Atom 订阅源片段（字段与 GitHub 真实输出一致，内容为 HTML 转义）。 */
function atomXml(tag: string, notesHtml: string, extra: string[] = []): string {
  const entry = (t: string, html: string) => `<entry>
  <link rel="alternate" type="text/html" href="https://github.com/${CANONICAL}/releases/tag/${t}"/>
  <title>PaperMate ${t} 正式版</title>
  <updated>2026-09-08T11:16:08Z</updated>
  <content type="html">${html}</content>
 </entry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
 ${[entry(tag, notesHtml), ...extra.map((t) => entry(t, "&lt;p&gt;旧版本&lt;/p&gt;"))].join("\n ")}
</feed>`;
}

interface StubOptions {
  /** /releases/latest 网页跳转最终指向的 tag；null 表示这条路径失败。 */
  pageTag?: string | null;
  /** Atom 订阅源里的最新 tag；null 表示订阅源不可用；不传则跟随 pageTag/apiTag。 */
  atomTag?: string | null;
  atomNotes?: string;
  /** API 兜底返回的 tag；不传表示 API 不可用。 */
  apiTag?: string | null;
  apiStatus?: number;
  apiRateLimited?: boolean;
  /** 附件：默认给一个能通过 SHA-256 校验的小包。 */
  archive?: Buffer;
  checksum?: string;
  /** 让附件或校验文件 404，模拟“只发布公告没传包”。 */
  missingAsset?: boolean;
  missingChecksum?: boolean;
  /** 谎报 content-length，模拟半截/异常下载。 */
  declaredSize?: number;
  record?: string[];
}

function stubGitHub(options: StubOptions = {}) {
  const archive = options.archive ?? Buffer.from("papermate update payload");
  const sha = options.checksum ?? createHash("sha256").update(archive).digest("hex");
  const tag = options.pageTag ?? options.atomTag ?? options.apiTag ?? "v" + version;
  const record = options.record ?? [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    record.push(url);

    if (url === `https://github.com/${REPO}/releases/latest`) {
      if (options.pageTag === null) return { ok: false, status: 500, url };
      return { ok: true, status: 200, url: `https://github.com/${CANONICAL}/releases/tag/${tag}` };
    }
    if (url === releasesAtomUrl()) {
      if (options.atomTag === null) return { ok: false, status: 404, text: async () => "" };
      const feedTag = options.atomTag ?? tag;
      return {
        ok: true,
        status: 200,
        text: async () => {
          if (options.atomNotes !== undefined) return atomXml(feedTag, options.atomNotes);
          return atomXml(
            feedTag,
            "&lt;h2&gt;更新内容&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;修好了某某问题&lt;/li&gt;&lt;/ul&gt;",
          );
        },
      };
    }
    if (url.startsWith("https://api.github.com/")) {
      if (options.apiTag === null || options.apiTag === undefined) return { ok: false, status: 404, headers: new Headers() };
      return {
        ok: options.apiStatus ? options.apiStatus < 400 : true,
        status: options.apiStatus ?? 200,
        headers: new Headers(options.apiRateLimited ? { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" } : {}),
        json: async () => ({
          tag_name: options.apiTag,
          draft: false,
          prerelease: false,
          body: "## API 更新说明",
          html_url: `https://github.com/${CANONICAL}/releases/tag/${options.apiTag}`,
          assets: [],
        }),
      };
    }
    if (url === `${downloadBase(tag)}/${UPDATE_CHECKSUM_ASSET}`) {
      if (options.missingChecksum) return { ok: false, status: 404, headers: new Headers(), text: async () => "" };
      return { ok: true, status: 200, headers: new Headers(), text: async () => `${sha}  ${UPDATE_ASSET}\n` };
    }
    if (url === `${downloadBase(tag)}/${UPDATE_ASSET}`) {
      if (options.missingAsset) return { ok: false, status: 404, headers: new Headers() };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(options.declaredSize ?? archive.length) }),
        body: { async *[Symbol.asyncIterator]() { yield new Uint8Array(archive); } },
      };
    }
    throw new Error("unexpected url " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function waitForPhase(phase: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = updateStatus();
    if (current.phase === phase) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return updateStatus();
}

beforeEach(() => {
  appData = mkdtempSync(path.join(os.tmpdir(), "papermate-update-appdata-"));
  installDir = mkdtempSync(path.join(os.tmpdir(), "papermate-update-install-"));
  process.chdir(installDir);
  previousEnv = process.env.PAPERMATE_APP_DATA;
  process.env.PAPERMATE_APP_DATA = appData;
  writeInstallConfig();
  writeStatus({ phase: "idle" });
  unlockUpdate();
});

afterEach(() => {
  // 注意：本文件每个真正发起下载的用例都会 await 到终态（ready/error）才结束。
  // 这很重要：download() 是后台任务，若跨过测试边界继续运行，它会读到下一个测试的
  // fetch 桩，并把状态写进下一个测试的 status.json（路径按当前 PAPERMATE_APP_DATA
  // 解析），让断言看到别人的消息——曾经导致「声明体积不符」用例偶发失败。
  // 这里不要写「等 phase 离开 downloading」的兜底轮询：有用例（本次进程自己发起的
  // downloading 不会被误判为中断）就是故意停在 downloading 的，会被白等超时。
  vi.unstubAllGlobals();
  unlockUpdate();
  if (previousEnv === undefined) delete process.env.PAPERMATE_APP_DATA;
  else process.env.PAPERMATE_APP_DATA = previousEnv;
  process.chdir(originalCwd);
  rmSync(appData, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});

describe.skipIf(!WINDOWS_X64)("更新环境识别", () => {
  it("登记为正式安装副本时 supported 为 true，并报告当前版本", () => {
    const status = updateStatus();
    expect(status.supported).toBe(true);
    expect(status.currentVersion).toBe(version);
  });

  it("没有 config.json（源码目录/未登记）时只能检测，不能自动安装", () => {
    rmSync(path.join(appData, "config.json"), { force: true });
    expect(updateStatus().supported).toBe(false);
    expect(() => beginDownload()).toThrow(/仅支持正式安装/);
  });
});

describe.skipIf(!WINDOWS_X64)("检测更新（优先走不消耗 API 配额的路径）", () => {
  it("没有新版：给出明确结论、不带更新说明，且只打一次网页跳转", async () => {
    const record: string[] = [];
    stubGitHub({ pageTag: "v" + version, record });
    const status = await checkUpdate();
    expect(status.phase).toBe("idle");
    expect(status.message).toContain("已是最新");
    expect(status.notes).toBeUndefined();
    // 关键：全程没有碰 api.github.com（未登录每小时只有 60 次）
    expect(record.some((url) => url.includes("api.github.com"))).toBe(false);
    expect(record).toEqual([`https://github.com/${REPO}/releases/latest`]);
  });

  it("有新版本：网页跳转拿到 tag，更新说明从 Atom 订阅源补齐", async () => {
    const record: string[] = [];
    stubGitHub({ pageTag: "v99.9", record });
    const status = await checkUpdate();
    expect(status.phase).toBe("available");
    expect(status.latestVersion).toBe("v99.9");
    expect(status.notes).toContain("修好了某某问题");
    expect(status.notes).not.toContain("<li>");
    expect(status.releaseUrl).toContain("/releases/tag/v99.9");
    expect(record.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  it("两段 tag 的新版本也能识别（历史 Release 就是 v3.6 这种写法）", async () => {
    stubGitHub({ pageTag: "v99.9" });
    const status = await checkUpdate();
    expect(status.phase).toBe("available");
    expect(status.latestVersion).toBe("v99.9");
  });

  it("网页跳转不可用时回退到 Atom 订阅源", async () => {
    stubGitHub({ pageTag: null, atomTag: "v99.8" });
    const status = await checkUpdate();
    expect(status.phase).toBe("available");
    expect(status.latestVersion).toBe("v99.8");
  });

  it("网页跳转与订阅源都不可用时才回退到 API", async () => {
    stubGitHub({ pageTag: null, atomTag: null, apiTag: "v99.7" });
    const status = await checkUpdate();
    expect(status.phase).toBe("available");
    expect(status.latestVersion).toBe("v99.7");
  });

  it("API 兜底也会被限流：这时才提示“调用次数已用完”，且不能当成最新版", async () => {
    stubGitHub({ pageTag: null, atomTag: null, apiTag: "v99.7", apiStatus: 403, apiRateLimited: true });
    const status = await checkUpdate();
    expect(status.phase).toBe("error");
    expect(status.message).toContain("调用次数已用完");
    expect(status.message).not.toContain("已是最新");
  });

  it("离线：显示明确错误，绝不写成“已是最新版”，并清掉上一次的版本信息", async () => {
    stubGitHub({ pageTag: "v99.9" });
    expect((await checkUpdate()).phase).toBe("available");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const status = await checkUpdate({ manual: true });
    expect(status.phase).toBe("error");
    expect(status.message).not.toContain("已是最新");
    expect(status.latestVersion).toBeUndefined();
    expect(status.notes).toBeUndefined();
  });

  it("自动检测有限频：6 小时内的第二次自动检测不再发请求，手动检测照常执行", async () => {
    const record: string[] = [];
    const fetchMock = stubGitHub({ pageTag: "v99.9", record });
    await checkUpdate();
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 紧接着的自动检测被跳过
    const skipped = await checkUpdate();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(skipped.phase).toBe("available");

    // 手动检测不受限制
    await checkUpdate({ manual: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(record.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!WINDOWS_X64)("下载更新包", () => {
  it("按 tag 直接构造附件地址并校验通过，进入 ready", async () => {
    const record: string[] = [];
    stubGitHub({ pageTag: "v99.9", record });
    await checkUpdate();
    beginDownload();
    const status = await waitForPhase("ready");
    expect(status.phase).toBe("ready");
    expect(status.progress).toBe(100);
    expect(record.some((url) => url.includes("api.github.com"))).toBe(false);
    expect(record).toContain(`${downloadBase("v99.9")}/${UPDATE_ASSET}`);
    const job = readJson(path.join(updatesDir(), "job.json"));
    expect(job.version).toBe("99.9");
    expect(job.tag).toBe("v99.9");
    expect(job.projectDir).toBe(process.cwd());
    expect(existsSync(String(job.archive))).toBe(true);
  });

  it("重复点击不会重复下载，也不会因为残留锁报 EEXIST", async () => {
    stubGitHub({ pageTag: "v99.9" });
    await checkUpdate();
    const first = beginDownload();
    const second = beginDownload();
    expect(["downloading", "ready"]).toContain(first.phase);
    expect(second.phase).toBe(first.phase);
    expect(existsSync(lockFile())).toBe(true);
    // 必须等这次下载落地：download() 是后台任务，若跨到下一个测试才结束，
    // 它会用下一个测试的 fetch 桩继续跑，并把 setState 写进下一个测试的 status 文件
    //（状态路径按当时的 PAPERMATE_APP_DATA 解析），造成跨测试串扰。
    expect((await waitForPhase("ready")).phase).toBe("ready");
  });

  it("校验失败：报错并释放锁，旧版本不受影响", async () => {
    stubGitHub({ pageTag: "v99.9", checksum: "0".repeat(64) });
    await checkUpdate();
    beginDownload();
    const status = await waitForPhase("error");
    expect(status.message).toContain("校验失败");
    expect(existsSync(lockFile())).toBe(false);
    expect(status.phase).not.toBe("ready");
  });

  it("只发布公告没传包：给出明确原因，不会安装残缺内容", async () => {
    stubGitHub({ pageTag: "v99.9", missingAsset: true });
    await checkUpdate();
    beginDownload();
    expect((await waitForPhase("error")).message).toContain("缺少有效的 Windows 更新包");
  });

  it("缺少 SHA-256 校验文件时拒绝安装（不装没校验的包）", async () => {
    stubGitHub({ pageTag: "v99.9", missingChecksum: true });
    await checkUpdate();
    beginDownload();
    expect((await waitForPhase("error")).message).toContain("校验文件");
  });

  it("声明体积与实际不符时中止（防止半截文件被当成完整包）", async () => {
    stubGitHub({ pageTag: "v99.9", declaredSize: 999999 });
    await checkUpdate();
    beginDownload();
    const status = await waitForPhase("error");
    expect(status.message).toContain("大小与 Release 声明不符");
    expect(status.phase).not.toBe("ready");
  });
});

describe.skipIf(!WINDOWS_X64)("中断恢复", () => {
  it("上次会话中断的 downloading 会被重置，用户不会永久卡住", () => {
    writeStatus({ phase: "downloading", progress: 37, ownerPid: 999999, updatedAt: Date.now() });
    writeFileSync(lockFile(), "");
    const status = updateStatus();
    expect(status.phase).toBe("idle");
    expect(status.message).toContain("下载已中断");
    expect(existsSync(lockFile())).toBe(false);
    expect(readStatus().phase).toBe("idle");
  });

  it("本次进程自己发起的 downloading 不会被误判为中断", () => {
    writeStatus({ phase: "downloading", progress: 42, ownerPid: process.pid, updatedAt: Date.now() });
    expect(updateStatus().phase).toBe("downloading");
  });

  it("残留锁 + 空闲状态：重新下载会自动清掉过期锁", async () => {
    stubGitHub({ pageTag: "v99.9" });
    await checkUpdate();
    mkdirSync(updatesDir(), { recursive: true });
    writeFileSync(lockFile(), "");
    expect(() => beginDownload()).not.toThrow();
    expect((await waitForPhase("ready")).phase).toBe("ready");
  });

  it("卡死的 installing 会转为错误，提示重新启动", () => {
    writeStatus({ phase: "installing", updatedAt: Date.now() - 60 * 60 * 1000, ownerPid: 1 });
    const status = updateStatus();
    expect(status.phase).toBe("error");
    expect(status.message).toContain("中断");
  });
});

describe.skipIf(!WINDOWS_X64)("安装前置条件", () => {
  it("更新包没准备好时拒绝安装", () => {
    writeStatus({ phase: "idle" });
    expect(() => installUpdate()).toThrow(/尚未就绪/);
  });

  it("还有模型请求在跑时拒绝安装（避免丢回答）", () => {
    writeStatus({ phase: "ready" });
    const finish = beginModelRequest();
    try {
      expect(() => installUpdate()).toThrow(/正在生成回答/);
    } finally {
      finish();
    }
  });

  it("下载/就绪/安装中不重复检测", async () => {
    writeStatus({ phase: "ready" });
    const stub = vi.fn();
    vi.stubGlobal("fetch", stub);
    expect((await checkUpdate()).phase).toBe("ready");
    expect(stub).not.toHaveBeenCalled();
  });
});

describe.skipIf(!WINDOWS_X64)("更新互斥", () => {
  it("lockForUpdate 在有活动请求时抛错，请求结束后可用", () => {
    const finish = beginModelRequest();
    expect(() => lockForUpdate()).toThrow();
    finish();
    expect(() => lockForUpdate()).not.toThrow();
    unlockUpdate();
  });
});

/**
 * 中文安装路径（例如 D:\论文助手）是这批 bug 的高发区：
 * 安装助手由 Windows PowerShell 5.1 执行，它的 Get-Content 默认按系统 ANSI 代码页解码，
 * 没有 BOM 的 UTF-8 文件会被解成乱码，轻则提示文字乱、重则路径解析失败直接更新中止。
 */
describe.skipIf(!WINDOWS_X64)("编码不变式（中文安装路径）", () => {
  it("apply-update.ps1 自身必须带 UTF-8 BOM", () => {
    const file = fileURLToPath(new URL("../scripts/apply-update.ps1", import.meta.url));
    expect(hasBom(file)).toBe(true);
  });

  it("scripts 下所有含中文的 .ps1 都必须带 UTF-8 BOM", () => {
    const dir = fileURLToPath(new URL("../scripts/", import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ps1")) continue;
      const file = path.join(dir, name);
      const bytes = readFileSync(file);
      if (bytes.some((byte) => byte > 0x7f) && !hasBom(file)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("检测后写出的 status.json 带 UTF-8 BOM，且 Node 侧能正常读回", async () => {
    stubGitHub({ pageTag: "v99.9" });
    await checkUpdate();
    expect(hasBom(statusFile())).toBe(true);
    expect(updateStatus().latestVersion).toBe("v99.9");
  });

  it("下载后写出的 job.json 带 UTF-8 BOM（含中文安装路径时必须）", async () => {
    stubGitHub({ pageTag: "v99.9" });
    await checkUpdate();
    beginDownload();
    await waitForPhase("ready");
    expect(hasBom(path.join(updatesDir(), "job.json"))).toBe(true);
  });
});
