import { describe, expect, it } from "vitest";
import { buddyScale, clampBuddyPosition } from "./buddy-layout";

describe("companion layout", () => {
  it("bounds saved sizes and handles invalid settings", () => {
    expect(buddyScale(NaN)).toBe(100);
    expect(buddyScale(0)).toBe(40);
    expect(buddyScale(41)).toBe(40);
    expect(buddyScale(47)).toBe(50);
    expect(buddyScale(1000)).toBe(180);
  });
  it("keeps the figure and independent controls inside a narrow viewport at every size", () => {
    for (const size of [40, 60, 80, 100, 120, 140, 160, 180]) {
      const pos = clampBuddyPosition({ x: 1900, y: 1000 }, size, { width: 320, height: 568 });
      expect(pos.x).toBeGreaterThanOrEqual(12);
      expect(pos.y).toBeGreaterThanOrEqual(20);
      expect(pos.x + 224).toBeLessThanOrEqual(308);
      expect(pos.y + 122 * size / 100 + 64).toBeLessThanOrEqual(556);
    }
  });
  it("keeps negative drag positions onscreen", () => {
    expect(clampBuddyPosition({ x: -400, y: -400 }, 100, { width: 1280, height: 720 })).toEqual({ x: 12, y: 20 });
  });
});
