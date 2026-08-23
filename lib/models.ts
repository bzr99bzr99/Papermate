import type { ModelProvider } from "@/lib/types";

/**
 * 模型体系：
 * - 内置模型（BUILTIN_MODELS）：4 个固定模型，展示信息与请求参数均保持不变；
 * - 自定义模型（CustomModelConfig）：用户在设置中自由增删改，OpenAI 兼容 chat/completions。
 * 本文件只包含类型、常量与纯函数，可被客户端安全导入（不依赖 node:fs）。
 */

export const BUILTIN_MODEL_IDS = ["glm-flash", "glm-47", "deepseek-flash", "kimi"] as const;
export type BuiltinModelId = (typeof BUILTIN_MODEL_IDS)[number];

export interface BuiltinModelInfo {
  provider: "deepseek" | "glm" | "kimi";
  /** 展示信息（左侧下拉 / 设置页） */
  label: string;
  badge: string;
  description: string;
  /** 请求信息（/api/chat） */
  url: string;
  model: string;
  fallbackModels?: string[];
  /** 是否发送 thinking 开关（快速/深度） */
  thinking: boolean;
  /** 深度模式下是否追加 reasoning_effort */
  reasoningEffortDeep?: boolean;
}

/** 内置模型定义：值与改动前 /api/chat 的 providerTargets/modelById 完全一致。 */
export const BUILTIN_MODELS: Record<BuiltinModelId, BuiltinModelInfo> = {
  "glm-flash": {
    provider: "glm",
    label: "GLM-4-Flash",
    badge: "免费 · 并发",
    description: "智谱免费 · 支持并发",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    fallbackModels: ["glm-4.7-flash"],
    thinking: true,
  },
  "glm-47": {
    provider: "glm",
    label: "GLM-4.7-Flash",
    badge: "免费 · 更强",
    description: "新一代 GLM 免费模型",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
    fallbackModels: ["glm-4-flash"],
    thinking: true,
  },
  "deepseek-flash": {
    provider: "deepseek",
    label: "DeepSeek Flash",
    badge: "快速",
    description: "DeepSeek 快速回复",
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffortDeep: true,
  },
  kimi: {
    provider: "kimi",
    label: "Kimi K2.6",
    badge: "长上下文",
    description: "Moonshot Kimi 模型",
    url: "https://api.moonshot.cn/v1/chat/completions",
    model: "kimi-k2.6",
    fallbackModels: ["kimi-k3", "kimi-k2.5"],
    thinking: true,
  },
};

/** 自定义模型配置（保存在 data/models.json，含 API Key，仅本机，不进备份）。 */
export interface CustomModelConfig {
  id: string;
  name: string;
  badge?: string;
  description?: string;
  /** OpenAI 兼容 chat/completions 请求地址 */
  baseUrl: string;
  /** 请求体中 model 字段 */
  model: string;
  apiKey?: string;
  /** 每次请求都合并的额外参数（stream/messages/model 由服务端强制覆盖） */
  params?: Record<string, unknown>;
  /** 深度模式（MAX 思考）下额外合并的参数 */
  deepParams?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 左侧下拉 / 设置页展示用的模型行（内置 + 自定义合并）。 */
export interface ClientModelOption {
  id: string;
  provider: ModelProvider;
  label: string;
  badge: string;
  description: string;
  builtin: boolean;
  hasKey: boolean;
}

export const CUSTOM_MODEL_BADGE = "自定义";

export const MAX_CUSTOM_MODELS = 50;

/** 合并内置与自定义模型为展示列表（自定义排在后面，按名称排序）。 */
export function mergeModelOptions(
  builtins: Record<BuiltinModelId, BuiltinModelInfo>,
  customs: CustomModelConfig[],
): ClientModelOption[] {
  const builtinRows: ClientModelOption[] = BUILTIN_MODEL_IDS.map((id) => {
    const info = builtins[id];
    return {
      id,
      provider: info.provider,
      label: info.label,
      badge: info.badge,
      description: info.description,
      builtin: true,
      hasKey: false, // 由服务端按 apikey.txt 填充
    };
  });
  const customRows: ClientModelOption[] = [...customs]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    .map((model) => ({
      id: model.id,
      provider: "custom" as ModelProvider,
      label: model.name,
      badge: model.badge?.trim() || CUSTOM_MODEL_BADGE,
      description: model.description?.trim() || `${model.baseUrl} · ${model.model}`,
      builtin: false,
      hasKey: Boolean(model.apiKey?.trim()),
    }));
  return [...builtinRows, ...customRows];
}

/** 自定义模型输入（params/deepParams 允许 JSON 字符串，由校验函数统一解析）。 */
export type CustomModelInput = Partial<Omit<CustomModelConfig, "params" | "deepParams">> & {
  params?: Record<string, unknown> | string;
  deepParams?: Record<string, unknown> | string;
};

/** 自定义模型输入校验（保存前客户端/服务端共用）。 */
export function validateCustomModel(
  input: CustomModelInput,
): { ok: true; value: CustomModelConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const badge = typeof input.badge === "string" ? input.badge.trim().slice(0, 20) : "";
  const description =
    typeof input.description === "string" ? input.description.trim().slice(0, 200) : "";

  if (!name) errors.push("请填写模型名称。");
  else if (name.length > 60) errors.push("模型名称不能超过 60 个字符。");

  if (!baseUrl) errors.push("请填写请求地址。");
  else if (baseUrl.length > 500) errors.push("请求地址不能超过 500 个字符。");
  else {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("请求地址必须以 http:// 或 https:// 开头。");
      }
    } catch {
      errors.push("请求地址不是合法的 URL。");
    }
  }

  if (!model) errors.push("请填写模型名称（请求体 model 字段）。");
  else if (model.length > 200) errors.push("模型名称不能超过 200 个字符。");

  if (apiKey.length > 500) errors.push("API Key 不能超过 500 个字符。");

  const parseParams = (value: unknown, label: string): Record<string, unknown> | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" && typeof value !== "object") {
      errors.push(`${label}必须是 JSON 对象。`);
      return undefined;
    }
    let parsed: unknown = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        errors.push(`${label}不是合法的 JSON。`);
        return undefined;
      }
    }
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") {
      errors.push(`${label}必须是 JSON 对象（如 {"temperature": 0.7}）。`);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  };
  const params = parseParams(input.params, "请求参数");
  const deepParams = parseParams(input.deepParams, "深度模式参数");

  if (errors.length) return { ok: false, errors };

  const now = new Date().toISOString();
  return {
    ok: true,
    value: {
      id: input.id || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `model-${Date.now()}`),
      name,
      badge: badge || undefined,
      description: description || undefined,
      baseUrl,
      model,
      apiKey: apiKey || undefined,
      params,
      deepParams,
      createdAt: input.createdAt || now,
      updatedAt: now,
    },
  };
}
