import { describe, expect, it } from "vitest";
import { markdownToMindMap, mindMapToSvg } from "./mindmap";

describe("mind map export", () => {
  it("turns a nested markdown list into a renderable SVG", () => {
    const tree = markdownToMindMap("- 研究问题\n  - 动机\n- 方法");
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].children[0].label).toBe("动机");
    const svg = mindMapToSvg(tree);
    expect(svg).toContain("<svg");
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('dominant-baseline="central"');
    const fills = svg.match(/fill="#[0-9a-fA-F]{6}"/g) ?? [];
    expect(new Set(fills).size).toBeGreaterThanOrEqual(2);
  });
});
