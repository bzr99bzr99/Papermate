/** 更新状态：既通过 /api/updates 返回给界面，也持久化到 %LOCALAPPDATA%\PaperMate\updates\status.json。 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "complete"
  | "error";

export interface UpdateStatus {
  currentVersion: string;
  /** 是否为「正式安装的 Windows x64 副本」——源码目录只能检测，不能自动覆盖安装。 */
  supported: boolean;
  phase: UpdatePhase;
  latestVersion?: string;
  notes?: string;
  releaseUrl?: string;
  progress?: number;
  message?: string;
  /** 状态最后写入时间（毫秒时间戳），用于识别被中断的下载/安装。 */
  updatedAt?: number;
  /** 最后一次完成版本检测的时间（毫秒时间戳），用于限制自动检测频率。 */
  checkedAt?: number;
  /** 写入该状态的进程号；与当前进程不同说明是上一次会话的残留状态。 */
  ownerPid?: number;
}

/** 这些阶段表示「有任务正在进行」，期间不再重复检测或重复下载。 */
export const UPDATE_ACTIVE_PHASES: UpdatePhase[] = ["downloading", "ready", "installing"];
