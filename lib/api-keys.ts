import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * API Key 以纯文本保存在 data/apikey.txt（明文，仅本机，data/ 目录不提交 Git）。
 * 服务端（聊天、探活、设置接口）直接读写该文件，浏览器不持有密钥。
 */
export interface ApiKeyPair {
  deepseek?: string;
  glm?: string;
  kimi?: string;
}

export function apiKeyFilePath(): string {
  return path.join(process.cwd(), "data", "apikey.txt");
}

export function parseApiKeyFile(content: string): ApiKeyPair {
  const result: ApiKeyPair = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if ((key === "deepseek" || key === "glm" || key === "kimi") && value) {
      result[key] = value;
    }
  }
  return result;
}

export function readApiKeyFile(): ApiKeyPair {
  try {
    return parseApiKeyFile(readFileSync(apiKeyFilePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeApiKeyFile(keys: ApiKeyPair): void {
  const deepseek = keys.deepseek?.trim() ?? "";
  const glm = keys.glm?.trim() ?? "";
  const kimi = keys.kimi?.trim() ?? "";
  const content = [
    "# PaperMate API Keys（明文保存在本机 data/ 目录，请勿外传或提交到代码仓库）",
    `deepseek=${deepseek}`,
    `glm=${glm}`,
    `kimi=${kimi}`,
    "",
  ].join("\n");
  const filePath = apiKeyFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${Date.now()}.tmp`;
  writeFileSync(tempFile, content, "utf8");
  try {
    renameSync(tempFile, filePath);
  } catch {
    rmSync(filePath, { force: true });
    renameSync(tempFile, filePath);
  }
}
