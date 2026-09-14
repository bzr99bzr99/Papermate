import { describe, expect, it } from "vitest";
import { buildSelectionQuote, selectItemIndexes, type SelectionItemBox } from "./selection-range";

/**
 * 一行被切成多个片段是 PDF 文本层的常态（每个片段一个绝对定位 span）。
 * 下面这些用例都用「行」来组织，行内片段首尾相接。
 */
function row(indexes: number[], left: number, right: number, top: number, height = 12): SelectionItemBox[] {
  const step = (right - left) / indexes.length;
  return indexes.map((index, position) => ({
    index,
    left: left + step * position,
    right: left + step * (position + 1),
    top,
    bottom: top + height,
  }));
}

describe("selectItemIndexes", () => {
  it("从某行中段拖到另一行中段时，中间整行都要选中（交集列带是曾经的 bug）", () => {
    // 第 1 行只有短短一段（起点落在其中），中间行满宽，第 3 行也只有一段（终点落在其中）
    const boxes = [
      ...row([0], 100, 160, 100),
      ...row([1, 2, 3], 100, 500, 120),
      ...row([4], 100, 170, 140),
    ];
    // 起点/终点都落在各行的第一段上（水平重叠 100%），旧逻辑会把列带压成 [96,164]
    const selected = selectItemIndexes({ boxes, lowIndex: 0, highIndex: 4, pointerTop: 104, pointerBottom: 146 });
    expect(selected).toEqual([0, 1, 2, 3, 4]);
  });

  it("指针停在行的上边缘时，该行其余片段也要选中（中心点判定会漏）", () => {
    const boxes = [
      ...row([0], 100, 200, 100),
      ...row([1, 2, 3], 100, 500, 120),
      ...row([4, 5], 100, 300, 140),
    ];
    // 抬起时指针贴在第 3 行上沿：中心点(146) 会落在带外
    const selected = selectItemIndexes({ boxes, lowIndex: 0, highIndex: 5, pointerTop: 104, pointerBottom: 141 });
    expect(selected).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("双栏：两端都在右栏时，左栏内容不能被卷进来", () => {
    const boxes = [
      ...row([0, 1], 40, 280, 100), // 左栏
      ...row([2, 3], 320, 560, 100), // 右栏
      ...row([4, 5], 40, 280, 120),
      ...row([6, 7], 320, 560, 120),
      ...row([8, 9], 320, 560, 140),
    ];
    const selected = selectItemIndexes({ boxes, lowIndex: 2, highIndex: 8, pointerTop: 104, pointerBottom: 146 });
    expect(selected).toEqual([2, 3, 6, 7, 8]);
  });

  it("index 窗口外的项一律不选（哪怕几何上落在同一带内）", () => {
    const boxes = [
      ...row([0], 100, 200, 100),
      ...row([1, 2], 100, 300, 120),
      ...row([3, 4], 100, 300, 140),
      ...row([5], 100, 200, 160),
    ];
    // 只选到第 3 行的第一段
    const selected = selectItemIndexes({ boxes, lowIndex: 1, highIndex: 3, pointerTop: 124, pointerBottom: 140 });
    expect(selected).toEqual([1, 2, 3]);
    expect(selected).not.toContain(0);
    expect(selected).not.toContain(4);
    expect(selected).not.toContain(5);
  });

  it("全部行在同一带内时保持升序输出", () => {
    const boxes = [...row([5, 6], 100, 300, 100), ...row([7], 100, 200, 120)];
    expect(selectItemIndexes({ boxes, lowIndex: 5, highIndex: 7, pointerTop: 104, pointerBottom: 126 })).toEqual([5, 6, 7]);
  });

  it("两端都没有几何信息时退化为纯窗口（宁可多选也不要漏）", () => {
    const boxes = [...row([3, 4], 100, 300, 100)];
    expect(selectItemIndexes({ boxes, lowIndex: 3, highIndex: 4, pointerTop: 0, pointerBottom: 0 })).toEqual([3, 4]);
  });

  it("窗口内没有任何盒模型时返回空", () => {
    expect(selectItemIndexes({ boxes: [], lowIndex: 0, highIndex: 3, pointerTop: 0, pointerBottom: 100 })).toEqual([]);
  });
});

describe("buildSelectionQuote", () => {
  const items = [
    { str: "We propose " },
    { str: "a new method", hasEOL: true },
    { str: "for reading " },
    { str: "papers.", hasEOL: true },
    { str: "Thanks.", blockId: "b2" },
  ];

  it("按选中片段拼接，保留行尾换行并压缩空白", () => {
    const { quote } = buildSelectionQuote({ items, itemIndexes: [0, 1, 2, 3], lowIndex: 0, highIndex: 3, lowOffset: 0, highOffset: 7 });
    expect(quote).toBe("We propose a new method\nfor reading papers.");
  });

  it("首尾片段按偏移裁剪（同一片段内选择时两端都裁）", () => {
    const { quote } = buildSelectionQuote({ items, itemIndexes: [0], lowIndex: 0, highIndex: 0, lowOffset: 3, highOffset: 10 });
    expect(quote).toBe("propose");
  });

  it("只在后面还有选中项时补换行，结尾不会多出空行", () => {
    const { quote } = buildSelectionQuote({ items, itemIndexes: [0, 1], lowIndex: 0, highIndex: 1, lowOffset: 0, highOffset: 12 });
    expect(quote).toBe("We propose a new method");
    expect(quote.endsWith("\n")).toBe(false);
  });

  it("收集涉及的文本块并去重", () => {
    const { blockIds } = buildSelectionQuote({
      items: [...items, { str: " more", blockId: "b2" }],
      itemIndexes: [0, 4, 5],
      lowIndex: 0,
      highIndex: 5,
      lowOffset: 0,
      highOffset: 5,
    });
    expect(blockIds).toEqual(["b2"]);
  });

  it("没有选中任何项时返回空串", () => {
    expect(buildSelectionQuote({ items, itemIndexes: [], lowIndex: 0, highIndex: 0, lowOffset: 0, highOffset: 0 }).quote).toBe("");
  });
});
