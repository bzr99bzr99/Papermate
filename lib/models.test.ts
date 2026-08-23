import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILTIN_MODEL_IDS,
  BUILTIN_MODELS,
  mergeModelOptions,
  validateCustomModel,
  type CustomModelConfig,
} from "./models";
import {
  modelsFilePath,
  readCustomModels,
  resolveModel,
  writeCustomModels,
} from "./models-store";

describe("validateCustomModel", () => {
  it("accepts a valid custom model and fills timestamps/id", () => {
    const result = validateCustomModel({
      name: "  我的本地模型  ",
      baseUrl: "https://api.example.com/v1/chat/completions",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("我的本地模型");
    expect(result.value.baseUrl).toBe("https://api.example.com/v1/chat/completions");
    expect(result.value.id).toBeTruthy();
    expect(result.value.createdAt).toBeTruthy();
    expect(result.value.updatedAt).toBeTruthy();
  });

  it("parses params as JSON strings and keeps the original id/createdAt on edit", () => {
    const result = validateCustomModel({
      id: "model-abc",
      createdAt: "2026-01-01T00:00:00.000Z",
      name: "A",
      baseUrl: "https://x.example.com/v1/chat/completions",
      model: "m1",
      apiKey: "",
      params: '{"temperature": 0.7, "max_tokens": 2048}',
      deepParams: '{"reasoning_effort": "high"}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("model-abc");
    expect(result.value.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.value.params).toEqual({ temperature: 0.7, max_tokens: 2048 });
    expect(result.value.deepParams).toEqual({ reasoning_effort: "high" });
    expect(result.value.apiKey).toBeUndefined(); // 空 Key 归一化为 undefined
  });

  it("rejects missing name / model and invalid URLs", () => {
    const missing = validateCustomModel({ baseUrl: "https://x.example.com", model: "m" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toContain("请填写模型名称。");

    const badUrl = validateCustomModel({ name: "A", baseUrl: "ftp://x.example.com", model: "m" });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.errors.join(" ")).toContain("http");

    const badUrl2 = validateCustomModel({ name: "A", baseUrl: "not a url", model: "m" });
    expect(badUrl2.ok).toBe(false);
    if (!badUrl2.ok) expect(badUrl2.errors.join(" ")).toContain("URL");
  });

  it("rejects malformed params JSON and non-object params", () => {
    const badJson = validateCustomModel({
      name: "A",
      baseUrl: "https://x.example.com",
      model: "m",
      params: "{oops",
    });
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.errors.join(" ")).toContain("JSON");

    const notObject = validateCustomModel({
      name: "A",
      baseUrl: "https://x.example.com",
      model: "m",
      deepParams: "[1,2]",
    });
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.errors.join(" ")).toContain("对象");
  });
});

describe("mergeModelOptions", () => {
  it("keeps the 4 builtin models first, then sorted custom models", () => {
    const customs: CustomModelConfig[] = [
      {
        id: "c2",
        name: "乙模型",
        baseUrl: "https://a.example.com",
        model: "m2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c1",
        name: "甲模型",
        baseUrl: "https://b.example.com",
        model: "m1",
        apiKey: "sk-x",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const rows = mergeModelOptions(BUILTIN_MODELS, customs);
    expect(rows.map((row) => row.id)).toEqual([...BUILTIN_MODEL_IDS, "c1", "c2"]);
    expect(rows[4].label).toBe("甲模型");
    expect(rows[4].hasKey).toBe(true);
    expect(rows[4].provider).toBe("custom");
    expect(rows[5].hasKey).toBe(false);
    expect(rows[5].badge).toBe("自定义"); // 未填徽标时的默认
  });

  it("maps builtin rows with their provider and labels", () => {
    const rows = mergeModelOptions(BUILTIN_MODELS, []);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ id: "glm-flash", provider: "glm", label: "GLM-4-Flash" });
    expect(rows[2]).toMatchObject({ id: "deepseek-flash", provider: "deepseek" });
  });
});

describe("models-store file roundtrip", () => {
  let dir: string;
  const sample: CustomModelConfig = {
    id: "c1",
    name: "测试模型",
    baseUrl: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "sk-secret",
    params: { temperature: 0.5 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "papermate-models-"));
    process.env.PAPERMATE_MODELS_FILE = path.join(dir, "models.json");
  });

  afterEach(() => {
    delete process.env.PAPERMATE_MODELS_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads empty list when file missing or corrupt", () => {
    expect(readCustomModels()).toEqual([]);
    writeFileSync(process.env.PAPERMATE_MODELS_FILE!, "{broken", "utf8");
    expect(readCustomModels()).toEqual([]);
  });

  it("roundtrips write → read and drops invalid entries", () => {
    writeCustomModels([sample]);
    expect(modelsFilePath()).toContain(dir);
    expect(readCustomModels()).toEqual([sample]);

    writeCustomModels([sample, { id: "bad", name: "", baseUrl: "", model: "" } as CustomModelConfig]);
    const loaded = readCustomModels();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("c1");
  });

  it("resolveModel: builtin by id, custom by config id, unknown undefined", () => {
    writeCustomModels([sample]);
    const builtin = resolveModel("glm-flash");
    expect(builtin?.kind).toBe("builtin");
    if (builtin?.kind === "builtin") expect(builtin.info.model).toBe("glm-4-flash");

    const custom = resolveModel("c1");
    expect(custom?.kind).toBe("custom");
    if (custom?.kind === "custom") expect(custom.config.apiKey).toBe("sk-secret");

    expect(resolveModel("does-not-exist")).toBeUndefined();
    expect(resolveModel(undefined)).toBeUndefined();
  });
});
