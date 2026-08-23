import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApiKeyFile } from "./api-keys";
import {
  BUILTIN_MODEL_IDS,
  BUILTIN_MODELS,
  mergeModelOptions,
  type BuiltinModelId,
  type BuiltinModelInfo,
  type ClientModelOption,
  type CustomModelConfig,
} from "./models";
/**
 * 自定义模型存储：data/models.json（含 API Key，明文本地，不进备份、不进 Git）。
 * 与 lib/api-keys.ts 同样的本地文件模式：浏览器只看到脱敏展示（GET 不含 Key）。
 */

export function modelsFilePath(): string {
  // 测试可用 PAPERMATE_MODELS_FILE 指向临时文件，避免写入真实 data/ 目录。
  return process.env.PAPERMATE_MODELS_FILE || path.join(process.cwd(), "data", "models.json");
}

function isValidCustomModel(value: unknown): value is CustomModelConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CustomModelConfig>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    typeof candidate.baseUrl === "string" &&
    candidate.baseUrl.trim().length > 0 &&
    typeof candidate.model === "string" &&
    candidate.model.trim().length > 0
  );
}

export function readCustomModels(): CustomModelConfig[] {
  try {
    const content = readFileSync(modelsFilePath(), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCustomModel);
  } catch {
    return [];
  }
}

export function writeCustomModels(models: CustomModelConfig[]): void {
  const filePath = modelsFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${Date.now()}.tmp`;
  writeFileSync(tempFile, JSON.stringify(models, null, 2), "utf8");
  try {
    renameSync(tempFile, filePath);
  } catch {
    rmSync(filePath, { force: true });
    renameSync(tempFile, filePath);
  }
}

/** 设置页 / 左侧下拉使用的完整模型列表（内置 + 自定义；不含自定义 Key）。 */
export function getAllModelOptions(): ClientModelOption[] {
  const keys = readApiKeyFile();
  const rows = mergeModelOptions(BUILTIN_MODELS, readCustomModels());
  return rows.map((row) =>
    row.builtin
      ? {
          ...row,
          hasKey: Boolean(keys[BUILTIN_MODELS[row.id as BuiltinModelId].provider]?.trim()),
        }
      : row,
  );
}

export type ResolvedModel =
  | { kind: "builtin"; id: BuiltinModelId; info: BuiltinModelInfo }
  | { kind: "custom"; id: string; config: CustomModelConfig };

export function resolveModel(modelId: string | undefined): ResolvedModel | undefined {
  if (!modelId) return undefined;
  if (BUILTIN_MODEL_IDS.includes(modelId as BuiltinModelId)) {
    return { kind: "builtin", id: modelId as BuiltinModelId, info: BUILTIN_MODELS[modelId as BuiltinModelId] };
  }
  const config = readCustomModels().find((item) => item.id === modelId);
  if (config) return { kind: "custom", id: modelId, config };
  return undefined;
}
