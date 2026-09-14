import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSystemPrompt,
  loadTaskInstructions,
  loadWebSearchPrompt,
  parsePromptsFile,
  SYSTEM_PROMPT_DEFAULT,
  taskInstructions,
  WEB_SEARCH_PROMPT_DEFAULT,
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
  it("keeps shipped overrides identical to all bundled fallback prompts", () => {
    const shipped = parsePromptsFile(readFileSync(path.join(process.cwd(), "public/prompts.txt"), "utf8"));
    const normalizeLines = (value: string | undefined) => value?.replace(/\r\n/g, "\n");
    expect(normalizeLines(shipped.system)).toBe(normalizeLines(SYSTEM_PROMPT_DEFAULT));
    expect(normalizeLines(shipped.websearch)).toBe(normalizeLines(WEB_SEARCH_PROMPT_DEFAULT));
    for (const task of Object.keys(taskInstructions) as Array<keyof typeof taskInstructions>) {
      expect(normalizeLines(shipped[task])).toBe(normalizeLines(taskInstructions[task]));
    }
  });
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
    expect(prompt).toContain("结合提供的论文上下文与用户选中内容");
    expect(prompt).toContain("不要只复述或翻译选段");
  });

  it("requires source-grounded answers with section citations", () => {
    const prompt = taskInstructions.context;
    expect(prompt).toContain("标注对应章节");
    expect(prompt).toContain("只能引用提供给你的原文");
    expect(prompt).toContain("全文结构、摘要、方法、实验、结果与结论");
    expect(prompt).toContain("相邻上下文");
  });

  it("keeps evidence, inference, and uncertainty explicit", () => {
    const prompt = taskInstructions.context;
    expect(prompt).toContain("原文明确表述");
    expect(prompt).toContain("基于论文证据的推理");
    expect(prompt).toContain("当前提供文本中未见说明");
    expect(prompt).toContain("补充解释");
    expect(prompt).toContain("边界与不确定处");
  });

  it("turns the current paper into a writing-craft lesson grounded in the text", () => {
    const prompt = taskInstructions.writing;
    expect(prompt).toContain("写作决策");
    expect(prompt).toContain("唯一教学样本");
    expect(prompt).toContain("不要脱离本文泛泛讲授论文写作规则");
    expect(prompt).toContain("论点→支撑证据");
    expect(prompt).toContain("可迁移的写作技巧清单");
    expect(prompt).toContain("标注对应章节");
    expect(prompt).toContain("只能引用提供给你的原文");
    expect(SYSTEM_PROMPT_DEFAULT).toContain("当前提供文本中未见说明");
    expect(prompt).toContain("论文优势、亮点与潜在审稿疑问");
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
    expect(loadSystemPrompt(path.join(os.tmpdir(), "papermate-prompts-does-not-exist.txt"))).toBe(
      SYSTEM_PROMPT_DEFAULT,
    );
  });

  it("reads the [system] block as the base system prompt", () => {
    const parsed = parsePromptsFile("[system]\n你是我的论文翻译助手。\n\n[translate]\n翻译。\n");
    expect(parsed.system).toBe("你是我的论文翻译助手。");
    expect(parsed.translate).toBe("翻译。");
    const file = tempPromptsFile("[system]\n你是我的论文翻译助手。\n\n[translate]\n自定义翻译指令。\n");
    expect(loadSystemPrompt(file)).toBe("你是我的论文翻译助手。");
    expect(loadTaskInstructions(file).translate).toBe("自定义翻译指令。");
  });

  it("parses the [websearch] block and falls back to the bundled default", () => {
    const parsed = parsePromptsFile("[websearch]\n只允许引用给定编号 [1]。\n");
    expect(parsed.websearch).toBe("只允许引用给定编号 [1]。");
    expect(loadWebSearchPrompt(tempPromptsFile("[websearch]\n自定义联网规则。\n"))).toBe("自定义联网规则。");
    // 文件缺失或没有该块时回退内置默认，且不影响任务提示词
    const file = tempPromptsFile("[translate]\n翻译。\n");
    expect(loadWebSearchPrompt(file)).toBe(WEB_SEARCH_PROMPT_DEFAULT);
    expect(loadTaskInstructions(file).translate).toBe("翻译。");
  });

  it("keeps the web search rules grounded in the numbered sources", () => {
    expect(WEB_SEARCH_PROMPT_DEFAULT).toContain("不是论文原文");
    expect(WEB_SEARCH_PROMPT_DEFAULT).toContain("编号必须来自检索结果里实际存在的条目");
    expect(WEB_SEARCH_PROMPT_DEFAULT).toContain("公开资料中未见相关说明");
  });
});

