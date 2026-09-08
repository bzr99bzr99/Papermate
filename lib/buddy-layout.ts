export const BUDDY_MIN_SCALE = 40;
export const BUDDY_MAX_SCALE = 180;
/* 尺寸量化步长（存储值对齐用）与按钮点击步长 */
export const BUDDY_SCALE_STEP = 10;
export const BUDDY_SIZE_STEP = 20;
export function buddyScale(value: number) {
  if (!Number.isFinite(value)) return 100;
  const snapped = Math.round(value / BUDDY_SCALE_STEP) * BUDDY_SCALE_STEP;
  return Math.min(BUDDY_MAX_SCALE, Math.max(BUDDY_MIN_SCALE, snapped));
}
export function clampBuddyPosition(pos: { x: number; y: number }, scale: number, viewport: { width: number; height: number }) {
  const width = Math.max(224, 92 * scale / 100);
  const height = 122 * scale / 100 + 64;
  return {
    x: Math.max(12, Math.min(pos.x, viewport.width - width - 12)),
    y: Math.max(20, Math.min(pos.y, viewport.height - height - 12)),
  };
}
