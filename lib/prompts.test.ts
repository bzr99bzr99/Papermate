import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTaskInstructions,
  parsePromptsFile,
  taskInstructions,
} from "./prompts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPromptsFile(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "papermate-prompts-"));
  tempDirs.push(dir);
  const file = path.join(dir, "prompts.txt");
  writeFileSync(file, content, "utf8");
  return file;
}

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

  it("turns the current paper into a writing-craft lesson grounded in the text", () => {
    const prompt = taskInstructions.writing;
    expect(prompt).toContain("作者是怎样把这篇论文写好的");
    expect(prompt).toContain("唯一教学样本");
    expect(prompt).toContain("不要脱离本文泛泛讲授论文写作规则");
    expect(prompt).toContain("论点→支撑证据");
    expect(prompt).toContain("可迁移的写作技巧清单");
    expect(prompt).toContain("标页码");
    expect(prompt).toContain("只能引用提供给你的原文");
    expect(prompt).toContain("原文未明确说明");
  });

  it("parses [task] blocks from the prompts text file", () => {
    const parsed = parsePromptsFile(
      "# comment\n[translate]\n自定义翻译指令。\n\n[notes]\n自定义笔记指令。\n",
    );
    expect(parsed.translate).toBe("自定义翻译指令。");
    expect(parsed.notes).toBe("自定义笔记指令。");
    expect(parsed.writing).toBeUndefined();
  });

  it("merges overrides from the text file and keeps defaults for missing tasks", () => {
    const file = tempPromptsFile("[translate]\n自定义翻译指令。\n[writing]\n自定义写作指令。\n");
    const loaded = loadTaskInstructions(file);
    expect(loaded.translate).toBe("自定义翻译指令。");
    expect(loaded.writing).toBe("自定义写作指令。");
    expect(loaded.context).toBe(taskInstructions.context);
    expect(loaded.notes).toBe(taskInstructions.notes);
  });

  it("falls back to built-in defaults when the prompts file is missing", () => {
    const loaded = loadTaskInstructions(
      path.join(os.tmpdir(), "papermate-prompts-does-not-exist.txt"),
    );
    expect(loaded).toEqual(taskInstructions);
  });
});
