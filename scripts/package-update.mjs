#!/usr/bin/env node
/**
 * 生成 Windows 预构建更新包：artifacts/windows
 *
 * 由 .github/workflows/release.yml 在打 tag 时调用；也可以本地直接运行做验证。
 *   node scripts/package-update.mjs            构建产物 → 组装 → 体检
 *   node scripts/package-update.mjs --verify   只体检已有的 artifacts/windows
 *
 * 产物布局（apply-update.ps1 与 start-papermate.ps1 依赖这个结构）：
 *   server.js               Next standalone 入口（start-papermate.ps1 优先用它）
 *   node.exe                便携 Node，正式安装不依赖系统 Node
 *   .next/                  含 BUILD_ID 与 static/（Next 要求手动补 static）
 *   node_modules/           被追踪到的运行时依赖
 *   public/                 提示词、拾句、人格（用户改动会在更新时保留）
 *   scripts/                启动/停止/卸载/更新助手脚本
 *   package.json            版本号必须与 Release tag 完全一致
 *   papermate-version.json  版本信息（版本、tag、sha 之外的元数据、文件数、体积）
 *
 * 安全底线：包里绝不允许出现 data/（明文 API Key 与论文库）、.git/、.env*。
 * 任何一条断言失败都会让 CI 直接失败，而不是发出一个泄漏数据的 Release。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "artifacts", "windows");
const verifyOnly = process.argv.includes("--verify");

/** 打包必须排除的目录/文件（相对包根）。 */
const FORBIDDEN = ["data", ".git", "artifacts", "coverage", "logs", "截图"];
const FORBIDDEN_FILES = [".env", ".env.local", ".env.production", "apikey.txt", "papermate.db", ".papermate-installed.json"];

function fail(message) {
  throw new Error(message);
}

function guard(child) {
  const resolved = path.resolve(child);
  if (!resolved.startsWith(target + path.sep)) fail("拒绝操作包目录之外的路径：" + resolved);
  return resolved;
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

/**
 * 取便携 Node 的版本号。
 * 刻意把 stdout 重定向到临时文件而不是用管道捕获：受限/沙箱环境下管道 stdio 会 spawn EPERM，
 * 重定向到文件则在任何环境行为一致。
 */
function nodeVersionOf(exe) {
  const out = path.join(tmpdir(), `papermate-node-${process.pid}-${Date.now()}.txt`);
  const fd = openSync(out, "w");
  try {
    const result = spawnSync(exe, ["--version"], { stdio: ["ignore", fd, "ignore"] });
    if (result.error) fail("无法运行便携 Node：" + result.error.message);
    if (result.status !== 0) fail("便携 Node 自检失败，退出码 " + result.status);
  } finally {
    closeSync(fd);
  }
  const version = readFileSync(out, "utf8").trim();
  try { unlinkSync(out); } catch { /* 临时文件清理失败无关紧要 */ }
  return version;
}

/** 期望的版本：tag 必须与 package.json 完全一致（安装器会用字符串严格比对）。 */
async function expectedVersion() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const tag = process.env.GITHUB_REF_NAME ?? "";
  if (!tag) return { version: pkg.version, tag: "v" + pkg.version, tagChecked: false };
  if (!/^v\d+(\.\d+){0,2}$/.test(tag)) fail("Release tag 必须是 vX / vX.Y / vX.Y.Z 形式，当前为 " + tag);
  if (tag !== "v" + pkg.version) {
    fail(`Release tag（${tag}）必须与 package.json 的版本（${pkg.version}）完全一致：请先把 package.json 改成 ${tag.replace(/^v/, "")} 再打 tag。`);
  }
  return { version: pkg.version, tag, tagChecked: true };
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else if (entry.isFile()) files.push({ path: path.relative(base, full).split(path.sep).join("/"), size: (await stat(full)).size });
  }
  return files;
}

async function build() {
  if (process.platform !== "win32" || process.arch !== "x64") fail("更新包只能在 Windows x64 上构建。");
  const standalone = path.join(root, ".next", "standalone");
  if (!(await exists(path.join(standalone, "server.js")))) {
    fail("缺少 .next/standalone/server.js：请先运行 npm run build（next.config.ts 必须开启 output: \"standalone\"）。");
  }
  if (!(await exists(path.join(root, ".next", "static")))) fail("缺少 .next/static，构建不完整。");

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  // 1) Next standalone 产物（server.js / .next / node_modules / 被追踪的文件）
  await cp(standalone, target, { recursive: true });
  // 2) Next 不会自动带上 static 与 public，必须手动补齐
  await cp(path.join(root, ".next", "static"), guard(path.join(target, ".next", "static")), { recursive: true });
  for (const name of ["public", "scripts"]) {
    await cp(path.join(root, name), guard(path.join(target, name)), { recursive: true, force: true });
  }
  // 3) 顶层文件（含预编译包自带的安装/卸载入口：用户下载 zip 解压后双击「一键安装.bat」即可安装，
  //    不需要 Node；「一键卸载.bat」让安装目录自己也能卸载，不必依赖开始菜单快捷方式）
  for (const name of ["package.json", "papermate.ico", "papermate.png", "papermate-uninstall.ico", "一键安装.bat", "一键卸载.bat"]) {
    if (await exists(path.join(root, name))) await cp(path.join(root, name), guard(path.join(target, name)), { force: true });
  }
  // 4) 便携 Node：正式安装不要求用户装 Node
  if (!(await exists(process.execPath))) fail("找不到当前 node.exe：" + process.execPath);
  await cp(process.execPath, guard(path.join(target, "node.exe")));
  const nodeVersion = nodeVersionOf(guard(path.join(target, "node.exe")));
  if (Number(nodeVersion.replace(/^v/, "").split(".")[0]) < 22) fail("便携 Node 版本过低（需要 22 及以上）：" + nodeVersion);

  // 4b) 补齐 Next 自身：standalone 的追踪会漏掉部分自引用模块，实测缺少
  //     next/dist/lib/metadata/get-metadata-route，导致 server.js 直接 MODULE_NOT_FOUND
  //     起不来（在“原生产物 .next/standalone”上同样可复现，是 Next 15.5 的追踪缺陷，
  //     与打包脚本无关）。这里把 next 包整体覆盖上去，代价约 108MB，
  //     换取“发布包一定能启动”——后面还有启动自检兜底。
  await cp(path.join(root, "node_modules", "next"), guard(path.join(target, "node_modules", "next")), { recursive: true, force: true });

  // 5) 清掉不该进包的内容
  for (const name of FORBIDDEN) await rm(guard(path.join(target, name)), { recursive: true, force: true });
  for (const name of FORBIDDEN_FILES) await rm(guard(path.join(target, name)), { force: true });
  await rm(guard(path.join(target, ".next", "cache")), { recursive: true, force: true });
  // 开发专用脚本不进包：预编译安装里没有源码，quick-patch（本地源码打补丁）对用户没有意义。
  for (const name of ["scripts/quick-patch.ps1"]) {
    await rm(guard(path.join(target, name)), { force: true });
  }
  for (const file of await walk(target)) {
    if (/(^|\/)\.env(\.|$)/.test(file.path) || /\.test\.(ts|tsx|mjs|js)$/.test(file.path) || file.path.endsWith(".tsbuildinfo")) {
      await rm(guard(path.join(target, file.path)), { force: true });
    }
  }
  console.log("便携 Node：" + nodeVersion);
}

/**
 * 启动自检：用包内自带的 node.exe 真的把这个包跑起来。
 * 这一步能抓到“结构齐全但起不来”的发布事故——例如 Next 漏拷自身模块时，
 * server.js 会在 MODULE_NOT_FOUND 上直接退出。宁可让 CI 失败，也不要发一个装完打不开的版本。
 */
async function smokeTest({ version }) {
  const appData = mkdtempSync(path.join(tmpdir(), "papermate-smoke-"));
  const logPath = path.join(appData, "server.log");
  const port = 39100 + (process.pid % 300);
  writeFileSync(path.join(appData, "config.json"), JSON.stringify({
    appName: "PaperMate", version, projectDir: target, installedCopy: true, port, url: `http://127.0.0.1:${port}`, sourceProjectDir: target,
  }, null, 2), "utf8");
  const log = openSync(logPath, "w");
  const child = spawn(guard(path.join(target, "node.exe")), [guard(path.join(target, "server.js"))], {
    cwd: target,
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", PAPERMATE_APP_DATA: appData, NODE_ENV: "production" },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  const stop = () => { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 已经退出 */ } };
  try {
    let status;
    let failure = "";
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/updates`, { signal: AbortSignal.timeout(2500) });
        if (response.ok) { status = await response.json(); break; }
      } catch {
        if (child.exitCode !== null) { failure = `服务进程提前退出（code ${child.exitCode}）`; break; }
      }
    }
    closeSync(log);
    if (!status) {
      const text = readFileSync(logPath, "utf8");
      const reason = text.split(/\r?\n/).find((line) => line.includes("Cannot find module") || line.includes("Error:")) ?? "";
      fail(`启动自检失败：${failure || "60 秒内没有响应"}${reason ? " —— " + reason.trim() : ""}\n${text.slice(-800)}`);
    }
    if (status.currentVersion !== version) fail(`启动自检失败：包内报告的版本是 ${status.currentVersion}，期望 ${version}。`);
    if (status.supported !== true) fail("启动自检失败：登记为正式安装副本后 supported 应为 true。");
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10000) });
    const html = await page.text();
    if (page.status !== 200 || !html.includes("PaperMate")) fail(`启动自检失败：首页返回 HTTP ${page.status}，内容不含 PaperMate。`);
    return { port, version: status.currentVersion };
  } finally {
    stop();
    rmSync(appData, { recursive: true, force: true });
  }
}

/** 硬断言：缺一个必需文件、或者混进任何敏感内容，都直接失败。 */
async function verify({ version }) {
  const files = await walk(target);
  const paths = new Set(files.map((file) => file.path));
  const required = [
    "server.js",
    "node.exe",
    "package.json",
    ".next/BUILD_ID",
    ".next/static",
    "node_modules/next/package.json",
    "public/prompts.txt",
    "public/buddy-personas.txt",
    "scripts/apply-update.ps1",
    // 更新器实际 spawn 的是启动器，它必须随包分发，否则安装阶段会直接失败。
    "scripts/launch-update.ps1",
    "scripts/start-papermate.ps1",
    "scripts/stop-papermate.ps1",
    "scripts/uninstall.ps1",
    "scripts/install-package.ps1",
    // 用户拿到 zip 之后的两个入口：装和卸。缺了用户就没有安装入口（或只能从开始菜单卸载）。
    "一键安装.bat",
    "一键卸载.bat",
  ];
  for (const name of required) {
    const ok = paths.has(name) || files.some((file) => file.path.startsWith(name + "/"));
    if (!ok) fail("更新包缺少必需内容：" + name);
  }

  const leaks = files.filter((file) =>
    FORBIDDEN.some((dir) => file.path.startsWith(dir + "/"))
    || FORBIDDEN_FILES.includes(file.path)
    || /(^|\/)\.env(\.|$)/.test(file.path)
    || file.path.endsWith("apikey.txt")
    || file.path.endsWith("papermate.db")
    || file.path.endsWith(".test.ts")
    || file.path.endsWith(".test.mjs"));
  if (leaks.length) {
    fail("更新包里混入了不该发布的内容（含用户数据/密钥风险），构建已中止：\n  " + leaks.slice(0, 20).map((file) => file.path).join("\n  "));
  }

  const pkg = JSON.parse(await readFile(guard(path.join(target, "package.json")), "utf8"));
  if (pkg.version !== version) fail(`包内 package.json 版本（${pkg.version}）与 Release 版本（${version}）不一致。`);
  const buildId = (await readFile(guard(path.join(target, ".next", "BUILD_ID")), "utf8")).trim();
  if (!buildId) fail(".next/BUILD_ID 为空。");

  const size = files.reduce((sum, file) => sum + file.size, 0);
  const versionFile = guard(path.join(target, "papermate-version.json"));
  const nodeVersion = nodeVersionOf(guard(path.join(target, "node.exe")));
  if (verifyOnly && (await exists(versionFile))) {
    const existing = JSON.parse(await readFile(versionFile, "utf8"));
    if (existing.version !== version) fail(`包内版本信息（${existing.version}）与 Release 版本（${version}）不一致。`);
  } else {
    await writeFile(versionFile, JSON.stringify({
      name: "papermate",
      version,
      tag: "v" + version,
      buildId,
      node: nodeVersion,
      files: files.length + 1,
      bytes: size,
      createdAt: new Date().toISOString(),
      platform: "windows-x64",
    }, null, 2) + "\n", "utf8");
  }
  return { files: files.length + 1, size };
}

try {
  const { version, tag, tagChecked } = await expectedVersion();
  if (verifyOnly) {
    if (!(await exists(target))) fail("artifacts/windows 不存在，请先运行不带 --verify 的打包。");
    const report = await verify({ version });
    console.log(`已校验 ${target}：${report.files} 个文件，${(report.size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`打包 PaperMate ${version}（tag ${tag}${tagChecked ? "，已校验一致" : "，本地模式未校验 tag"}）`);
    await build();
    const report = await verify({ version });
    if (process.argv.includes("--no-smoke")) {
      console.log("已跳过启动自检（--no-smoke）。");
    } else {
      const smoke = await smokeTest({ version });
      console.log(`启动自检通过：包内 node.exe 拉起 server.js，端口 ${smoke.port}，自报版本 ${smoke.version}。`);
    }
    console.log(`已生成 ${target}：${report.files} 个文件，${(report.size / 1024 / 1024).toFixed(1)} MB`);
    console.log("下一步：压缩为 artifacts/papermate-windows-x64.zip 并生成 SHA-256（见 release.yml）。");
  }
} catch (error) {
  console.error("打包失败：" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
