"use client";
import { useEffect, useRef, useState } from "react";
import { UPDATE_ACTIVE_PHASES, type UpdateStatus } from "@/lib/update-types";

/**
 * 自动更新界面。
 * - 每次打开页面后台检测一次，发现新版本才弹窗，不阻塞打开论文；
 * - 设置页显示当前版本、检测按钮与检测结果（检测失败显示明确错误，绝不写成“已是最新版”）；
 * - 安装期间服务会短暂不可用，轮询静默容错，健康检查通过后自动刷新页面。
 */

/** 每个页面会话只自动检测一次。 */
let startupChecked = false;

/** 轮询间隔：进行中的阶段快一些，空闲时慢一些，避免常驻高频请求。 */
const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 20000;

async function fetchStatus(): Promise<UpdateStatus | undefined> {
  try {
    const response = await fetch("/api/updates", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    return (await response.json()) as UpdateStatus;
  } catch {
    // 替换安装期间服务会短暂断开，属于预期情况。
    return undefined;
  }
}

async function post(action: "check" | "download" | "install", options: { manual?: boolean } = {}): Promise<UpdateStatus> {
  const response = await fetch("/api/updates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // manual=true 跳过服务端的自动检测限频（默认 6 小时内只自动检测一次，避免撞 GitHub 限流）。
    body: JSON.stringify({ action, ...(options.manual ? { manual: true } : {}) }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "更新操作失败");
  return result as UpdateStatus;
}

/** 状态变化广播：设置页的小卡片借此同步显示，无需自己再发一次检测请求。 */
function broadcast(status: UpdateStatus) {
  window.dispatchEvent(new CustomEvent<UpdateStatus>("papermate-update-status", { detail: status }));
}

/** 设置页「软件更新」卡片：当前版本 + 检测按钮 + 最近一次检测结果。 */
export function CheckUpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    let alive = true;
    void fetchStatus().then((next) => { if (alive && next) setStatus(next); });
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<UpdateStatus>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener("papermate-update-status", onStatus);
    return () => { alive = false; window.removeEventListener("papermate-update-status", onStatus); };
  }, []);
  const phase = status?.phase;
  const result = !status
    ? "正在读取版本信息…"
    : phase === "error"
      ? status.message ?? "检测更新失败"
      : phase === "available"
        ? `发现新版本 ${status.latestVersion ?? ""}`
        : phase === "downloading" || phase === "ready" || phase === "installing"
          ? status.message ?? "更新进行中"
          : status.message ?? "尚未检测";
  return (
    <section className="settings-block">
      <div className="settings-block-head">
        <span className="settings-kicker">APP UPDATE</span>
        <h3>软件更新</h3>
        <p>仅检测 GitHub 正式 Release（忽略草稿与预发布）。论文、笔记、对话、密钥与自定义提示词都会保留。</p>
      </div>
      <p className="settings-hint">
        当前版本：<b>{status?.currentVersion ?? "读取中…"}</b>
        {status?.latestVersion && phase !== "error" ? ` · 最新正式版本：${status.latestVersion}` : ""}
      </p>
      <p className={`settings-hint ${phase === "error" ? "update-result-bad" : phase === "available" ? "update-result-good" : ""}`}>{result}</p>
      {status && !status.supported && (
        <p className="settings-hint">当前是源码运行或不支持的安装环境，只能检测版本；自动覆盖安装仅用于正式安装的 Windows x64 版本。</p>
      )}
      <div className="settings-websearch-actions">
        <button type="button" className="test-key" onClick={() => window.dispatchEvent(new Event(phase && UPDATE_ACTIVE_PHASES.includes(phase) ? "papermate-show-update" : "papermate-check-update"))}>{phase && UPDATE_ACTIVE_PHASES.includes(phase) ? "查看更新进度" : "检查更新"}</button>
        {status?.releaseUrl && <button type="button" className="test-key" onClick={() => window.open(status.releaseUrl, "_blank", "noopener")}>查看发布说明</button>}
      </div>
    </section>
  );
}

export function UpdateManager({ busy, prepare }: { busy: boolean; prepare: () => Promise<void> }) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [visible, setVisible] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [connectionWarning, setConnectionWarning] = useState("");
  const dismissed = useRef(false);
  const lastContact = useRef(Date.now());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const statusRef = useRef<UpdateStatus | undefined>(undefined);
  const checking = useRef(false);
  const installStarted = useRef(false);
  const mountedVersion = useRef<string | undefined>(undefined);

  async function action(name: "check" | "download" | "install", options: { manual?: boolean } = {}) {
    const result = await post(name, options);
    statusRef.current = result;
    setStatus(result);
    broadcast(result);
    return result;
  }

  useEffect(() => {
    let disposed = false;
    let timer = 0;

    async function check(manual: boolean) {
      if (checking.current) return;
      checking.current = true;
      if (manual) { dismissed.current = false; setVisible(true); setError(""); }
      try {
        const next = await action("check", { manual });
        if (!disposed && !dismissed.current && (manual || next.phase === "available")) setVisible(true);
      } catch (failure) {
        if (manual && !disposed) setError(String(failure));
      } finally {
        checking.current = false;
      }
    }
    const manual = () => void check(true);
    const show = () => { dismissed.current = false; setVisible(true); };
    window.addEventListener("papermate-show-update", show);
    window.addEventListener("papermate-check-update", manual);
    if (!startupChecked) { startupChecked = true; void check(false); }

    async function apply(next: UpdateStatus) {
      mountedVersion.current ??= next.currentVersion;
      statusRef.current = next;
      setStatus(next);
      broadcast(next);
      lastContact.current = Date.now();
      setConnectionWarning(next.phase === "installing" && next.updatedAt && Date.now() - next.updatedAt > 120000
        ? "安装状态超过两分钟未更新。可关闭此窗口；请查看安装日志，勿重复启动安装。" : "");
      if (next.phase === "installing") { if (!dismissed.current) setVisible(true); setInstalling(true); }
      if (next.phase === "complete") { setInstalling(false); setAuthorized(false); installStarted.current = false; }
      if (next.phase === "complete" && mountedVersion.current !== next.currentVersion) window.location.reload();
      if (next.phase === "error") { setInstalling(false); setAuthorized(false); installStarted.current = false; }
    }

    // 自适应轮询：下载/安装期间 2 秒一次，空闲时 20 秒一次；后台标签页不打扰。
    async function tick() {
      if (disposed) return;
      if (!document.hidden) {
        const next = await fetchStatus();
        if (next && !disposed) await apply(next);
        else if (!disposed && statusRef.current?.phase === "installing") {
          setConnectionWarning(Date.now() - lastContact.current > 90000
            ? "暂时无法连接服务，无法确认安装结果。可关闭窗口并从启动快捷方式重新打开；不要重复安装。"
            : "服务正在重启，暂时无法读取进度；连接恢复后会自动同步。");
        }
      }
      schedule();
    }
    function schedule() {
      if (disposed) return;
      const phase = statusRef.current?.phase;
      const delay = phase && UPDATE_ACTIVE_PHASES.includes(phase) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      timer = window.setTimeout(() => void tick(), delay);
    }
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    void tick();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("papermate-check-update", manual);
      window.removeEventListener("papermate-show-update", show);
    };
  }, []);

  // 拿到 ready 状态后：等界面上的生成任务结束 → 落盘 → 交给更新助手安装。
  useEffect(() => {
    if (!authorized || busy || status?.phase !== "ready" || installStarted.current) return;
    installStarted.current = true;
    setInstalling(true);
    void (async () => {
      try {
        await prepareRef.current();
        if (busyRef.current) { installStarted.current = false; setInstalling(false); return; }
        await action("install");
      } catch (failure) {
        setError(String(failure));
        setInstalling(false);
        setAuthorized(false);
        installStarted.current = false;
      }
    })();
  }, [authorized, busy, status?.phase]);

  function close() { dismissed.current = true; setVisible(false); }
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissed.current = true; setVisible(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);
  if (!visible) return installing || authorized ? <button className="papermate-update-resume" onClick={() => { dismissed.current = false; setVisible(true); }}>更新进行中 · 查看进度</button> : null;
  const inProgress = status?.phase === "downloading" || installing;
  const showLatest = status?.phase === "available" || status?.phase === "ready" || inProgress || status?.phase === "complete";
  return (
    <div className="papermate-update-overlay" role="dialog" aria-modal="true" aria-label="软件更新">
      <div className="papermate-update-card">
        <div className="papermate-update-heading"><h2>软件更新</h2><button type="button" aria-label="关闭软件更新" onClick={close}>×</button></div>
        <p>
          当前版本：{status?.currentVersion ?? "读取中…"}
          {showLatest && status?.latestVersion ? ` · 最新版本：${status.latestVersion}` : ""}
        </p>
        <p role="status">{error || (authorized && busy ? "等待当前任务完成后自动安装…" : status?.message || "正在检测更新…")}</p>
        {status?.notes && <pre>{status.notes}</pre>}
        {status?.phase === "downloading" && <div><label>下载进度：{status.progress ?? 0}%</label><progress aria-label="下载进度" max={100} value={status.progress ?? 0} /></div>}
        {(installing || status?.phase === "complete") && <div className="papermate-install-progress">
          <p>{status?.installStage || "正在保存数据并准备安装"}{status?.installProgress !== undefined ? " · " + status.installProgress + "%" : ""}</p>
          <progress aria-label="安装进度" max={100} value={connectionWarning ? undefined : status?.phase === "complete" ? 100 : status?.installProgress ?? 0} />
          <small>校验 → 解压 → 备份 → 替换 → 启动验证</small>
        </div>}
        {connectionWarning && <p role="status">{connectionWarning}</p>}
        {status && !status.supported && (
          <p>当前是源码运行或不支持的安装环境，可检测版本；自动覆盖安装仅支持正式安装的 Windows x64 版本。</p>
        )}
        {status?.releaseUrl && <a href={status.releaseUrl} target="_blank" rel="noreferrer">查看 GitHub 发布说明</a>}
        <div className="papermate-update-actions">
          <button type="button" onClick={close}>{installing ? "关闭进度窗口" : "返回"}</button>
          {status?.supported && ["available", "ready"].includes(status.phase) && (
            <button disabled={authorized} onClick={() => {
              setError("");
              setAuthorized(true);
              if (status.phase !== "ready") {
                void action("download").catch((failure) => { setError(String(failure)); setAuthorized(false); });
              }
            }}>立即更新</button>
          )}
          {!inProgress && <button onClick={() => window.dispatchEvent(new Event("papermate-check-update"))}>重新检测</button>}
        </div>
        {installing && <p>更新在后台继续。关闭此进度窗口不会取消安装；完成后自动刷新页面。请勿关闭电脑。</p>}
        {status?.phase === "complete" && <button type="button" onClick={() => window.location.reload()}>刷新页面</button>}
      </div>
    </div>
  );
}
