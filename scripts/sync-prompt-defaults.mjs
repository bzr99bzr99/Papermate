import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep editable prompts and the bundled fallback identical after intentional updates.
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("public/prompts.txt", root), "utf8");
const blocks = Object.fromEntries([...source.matchAll(/^\[([a-z]+)\]\s*\r?\n([\s\S]*?)(?=^\[[a-z]+\]\s*$|(?![\s\S]))/gm)].map((m) => [m[1], m[2].trim()]));
const tasks = ["translate", "context", "concept", "free", "notes", "mindmap", "writing"];
for (const key of ["system", ...tasks]) {
  if (!blocks[key]) throw new Error(`Missing prompt block: ${key}`);
}
const target = new URL("lib/prompts.ts", root);
const original = await readFile(target, "utf8");
const start = original.indexOf("export const taskInstructions:");
const end = original.indexOf("/**\n * 提示词保存在", start);
const crlfEnd = original.indexOf("/**\r\n * 提示词保存在", start);
const boundary = end >= 0 ? end : crlfEnd;
if (start < 0 || boundary < 0) throw new Error("Prompt source boundaries not found");
const generated = `export const taskInstructions: Record<Task, string> = ${JSON.stringify(Object.fromEntries(tasks.map((key) => [key, blocks[key]])), null, 2)};\n\n/** Bundled fallback; update with scripts/sync-prompt-defaults.mjs. */\nexport const SYSTEM_PROMPT_DEFAULT = ${JSON.stringify(blocks.system)};\n\n`;
await writeFile(target, original.slice(0, start) + generated + original.slice(boundary));
console.log(`Synced ${tasks.length} tasks and system prompt to ${fileURLToPath(target)}`);
