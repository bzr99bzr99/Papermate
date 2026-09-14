const state = globalThis as typeof globalThis & { papermateUpdateActivity?: { active: number; installing: boolean } };
function activity() { return state.papermateUpdateActivity ??= { active: 0, installing: false }; }
export function beginModelRequest() {
  if (activity().installing) throw new Error("正在更新，请稍后重试");
  activity().active++;
  let finished = false;
  return () => { if (!finished) { finished = true; activity().active--; } };
}
export function lockForUpdate() {
  if (activity().active) throw new Error("正在生成回答，请等待完成后更新。");
  if (activity().installing) throw new Error("更新已经开始。");
  activity().installing = true;
}
export function unlockUpdate() { activity().installing = false; }
