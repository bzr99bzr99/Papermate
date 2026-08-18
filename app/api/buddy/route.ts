import { NextResponse } from "next/server";
import { readApiKeyFile } from "@/lib/api-keys";
import {
  loadBuddyPersona,
  loadBuddyFallback,
  type BuddyPersona,
} from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/** 陪读小人的事件场景（与前端派发的事件类型对齐）。 */
export type BuddyEvent =
  | "paper-open"
  | "paper-close"
  | "ask"
  | "translate"
  | "explain"
  | "generate:notes"
  | "generate:mindmap"
  | "generate:writing"
  | "done:notes"
  | "done:mindmap"
  | "done:writing"
  | "idle";

const PERSONAS: BuddyPersona[] = ["sarcastic", "soft", "philosopher", "encourager", "mentor"];

/** 事件标签 = 明确告诉小人“当前功能是什么”（翻译=正在翻译，脑图=正在生成脑图…）。 */
const EVENT_LABELS: Record<BuddyEvent, string> = {
  "paper-open": "用户刚刚打开了一篇论文",
  "paper-close": "用户刚刚读完论文、返回了论文库",
  ask: "用户现在正在使用选段问答/自由提问功能",
  translate: "用户现在正在使用翻译功能，翻译论文原文",
  explain: "用户现在正在使用结合上下文解释/详细讲解功能",
  "generate:notes": "用户现在正在生成这篇论文的阅读笔记",
  "generate:mindmap": "用户现在正在生成这篇论文的思维导图",
  "generate:writing": "用户现在正在生成这篇论文的写作思路分析",
  "done:notes": "用户刚刚完成了阅读笔记的生成",
  "done:mindmap": "用户刚刚完成了思维导图的生成",
  "done:writing": "用户刚刚完成了写作思路分析的生成",
  idle: "用户正在安静地阅读论文（或短暂停顿）",
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    persona?: string;
    event?: string;
    title?: string;
    payload?: string;
  };
  const persona: BuddyPersona = PERSONAS.includes(body.persona as BuddyPersona)
    ? (body.persona as BuddyPersona)
    : "soft";
  const event = EVENT_LABELS[body.event as BuddyEvent] ? (body.event as BuddyEvent) : "idle";
  const title = body.title?.slice(0, 200) ?? "";
  // 场景补充内容：问答/翻译传“原文选段+提问+回答”，成果生成传“论文摘要”。
  const payload = body.payload?.slice(0, 600) ?? "";

  // 有 GLM Key 时用 glm-4-flash 生成一句话；无 Key / 调用失败时静默降级本地语料。
  const apiKey = readApiKeyFile().glm?.trim();
  if (apiKey) {
    try {
      const personaPrompt = loadBuddyPersona(persona);
      const upstream = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          model: "glm-4-flash",
          stream: false,
          // 温度取智谱 API 允许的最高值 1.0，让回答更多样化（相同场景/内容下输出变化更丰富）
          max_tokens: 130,
          temperature: 1.0,
          messages: [
            { role: "system", content: personaPrompt },
            {
              role: "user",
              content: `当前事件：${EVENT_LABELS[event]}${title ? `（论文：${title}）` : ""}${payload ? `\n补充内容：\n${payload}` : ""}\n按你的性格自由发挥：口语化、两三句话以内、简短自然；可点评、可提问、可抛出话题，思路方向不受限制；不要复述全部内容，不要输出 Markdown。`,
            },
          ],
        }),
      });
      if (upstream.ok) {
        const data = (await upstream.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return NextResponse.json({ text: text.slice(0, 200) }, { headers: noStore });
        }
      }
    } catch {
      // 降级到本地语料
    }
  }

  const text = pickFallback(event, persona);
  return NextResponse.json({ text, fallback: true }, { headers: noStore });
}

function pickFallback(event: BuddyEvent, persona: BuddyPersona): string {
  const groups = loadBuddyFallback();
  const key = `${event}|${persona}`;
  const pool = groups[key] ?? groups[`${event}|soft`] ?? ["（小人悄悄翻了一页书。）"];
  return pool[Math.floor(Math.random() * pool.length)] ?? "（小人悄悄翻了一页书。）";
}
