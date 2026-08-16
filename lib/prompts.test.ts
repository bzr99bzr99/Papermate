import { describe, expect, it } from "vitest";
import { taskInstructions } from "./prompts";

describe("task prompts", () => {
  it("keeps a dedicated instruction for every chat task", () => {
    expect(Object.keys(taskInstructions).sort()).toEqual([
      "concept",
      "context",
      "free",
      "mindmap",
      "notes",
      "translate",
      "writing",
    ]);
  });

  it("makes the input-box question the core of context explanations", () => {
    const prompt = taskInstructions.context;
    expect(prompt).toContain("输入框中提出的问题为核心");
    expect(prompt).toContain("先直接回答用户问题");
    expect(prompt).toContain("结合论文全文上下文与用户选中内容");
    expect(prompt).toContain("不要只复述或翻译选段");
  });

  it("requires source-grounded answers with page citations", () => {
    const prompt = taskInstructions.context;
    expect(prompt).toContain("标注页码");
    expect(prompt).toContain("只能引用提供给你的原文");
    expect(prompt).toContain("全文结构、摘要、方法、实验、结果与结论");
    expect(prompt).toContain("相邻上下文");
  });

  it("keeps evidence, inference, and uncertainty explicit", () => {
    const prompt = taskInstructions.context;
    expect(prompt).toContain("原文明确表述");
    expect(prompt).toContain("基于论文证据的推理");
    expect(prompt).toContain("原文未明确说明");
    expect(prompt).toContain("补充解释");
    expect(prompt).toContain("边界与不确定处");
  });
});
