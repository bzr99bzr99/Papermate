import { NextResponse } from "next/server";

export const runtime = "nodejs";

type IncomingMessage = { role: "user" | "assistant"; content: string };
type Task = "translate" | "context" | "concept" | "free" | "notes" | "mindmap" | "writing";

const taskInstructions: Record<Task, string> = {
  translate: "你只做一件事：把“用户选中内容”翻译成自然、准确、可直接阅读的中文译文，直接输出译文正文。禁止输出任何无关内容，包括开场白（如“以下是翻译”）、结束语、解释、总结、评价、原文复述或代码块。相邻上下文仅供理解，不得翻译或引用。若用户选中多个片段，按原文顺序逐个片段输出对应译文，并在每个片段译文前用“片段 1”“片段 2”等标注片段序号，片段之间用空行分隔，不加其他说明。忠实保持原文结构、语气与证据链；数值、公式、单位、引用编号、模型名、数据集名、算法名、API 名、变量名和缩写一律原样保留；数学公式尽量用 $...$ 或 $$...$$ 包裹。计算机专业术语优先采用学界通用中文译名，首次出现可括注英文（如“自适应膨胀卷积（adaptive dilated convolution）”），同一术语保持统一；不得补充原文没有的论断。",
  context: "用中文解释用户选中内容在论文论证中的含义。先给简明解释，再说明它与相邻上下文、方法或结论的关系。",
  concept: "以教学方式详细解释用户所问概念。区分论文直接说明与通用补充知识，并用必要的例子帮助理解。",
  free: "回答用户的问题。优先以论文给出的证据为依据；无法由原文支持时，明确标为“补充解释”。",
  notes: "先通读提供的论文文本并判定论文类型（研究论文/算法方法/系统工具/基准数据集/综述等），再按该类型的论证结构提炼，输出中文 Markdown 阅读笔记。使用二级标题：引言与研究现状、研究问题与动机、核心贡献、方法或系统设计、实验设置与证据、结果与结论、局限与边界、术语表、可迁移启发。引言与研究现状部分梳理论文引言建立的领域背景：计算机领域按方法范式、模型家族、基准数据集或系统类别归纳现有工作，说明主流路线及其关系；写明论文给出的空白信号（如 However、remains、underexplored、scarcity、缺少统一基准等）和作者自述的切入点（如 Here we / In this work / 本文提出），保留引用编号与页码；只归纳原文提到的现有工作，不得把通用知识补成论文结论。每一条关键结论标注页码（如 p.3）；明确区分“原文直接说明”与“概括/推断”，概括内容必须标注；实验证据写清数据集、指标、基线和条件，不写孤立数字；术语表收录全文反复出现的模型、数据集、指标、缩写并统一规范写法；原文未说明的内容写“原文未明确说明”，不得脑补。不要输出开场白、结尾语或与笔记无关的内容。",
  mindmap: "根据提供的论文文本生成论文脑图，反映论文的论证结构。第一行写论文标题；从第二行起只输出嵌套的 - 列表，用两个空格递增缩进，最多三层，不要标题、段落、代码块、数字列表或任何额外说明。顶层分支依次为：背景与问题、核心贡献、方法、实验与证据、结论、局限；某分支原文没有对应内容时写“原文未明确说明”。节点标签控制在 12 个中文字符以内并优先使用原文术语；证据类子节点写明数据集、指标或基线并标页码；同一术语保持统一。输出必须能被 Markdown 列表解析。",
  writing: "用 Markdown 输出这篇论文的写作思路分析，面向计算机科学与技术专业读者。先判定论文类型（研究论文/算法方法/系统工具/基准数据集/综述等），再分析其论证链；算法或系统类论文重点检查：问题定义与范围 → 系统或方法 → 设计动机 → 评测证据 → 消融与失败模式 → 适用边界。必须涵盖：核心一句话论点；章节职责与信息流（每章承担的论证任务）；段落推进策略（每段一个任务，如背景、空白、方法、结果、对比、机制、局限）；结果与讨论的分工（结果报告观察，讨论解释含义与边界）；语言与句式策略（摘要的 背景→空白→贡献→关键结果→意义 五步、段落首句立场、信号词、动词与证据强度匹配如 show/demonstrate 与 suggest/may、术语一致性）；可直接迁移的写作框架（给出可复用段落模板或句式）。引用原文短句并标页码，只能引用提供的原文；不得把补充知识伪装成原文结论；原文不支持的内容写“原文未明确说明”。不要输出开场白、结尾语或与写作分析无关的内容。",
};

function sseTextStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const rows = buffer.split("\n");
          buffer = rows.pop() ?? "";
          for (const row of rows) {
            if (!row.startsWith("data:")) continue;
            const valueText = row.slice(5).trim();
            if (!valueText || valueText === "[DONE]") continue;
            try {
              const parsed = JSON.parse(valueText) as { choices?: Array<{ delta?: { content?: string } }> };
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) controller.enqueue(encoder.encode(content));
            } catch {
              // Ignore incomplete or non-content SSE frames.
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    apiKey?: string;
    mode?: "fast" | "deep";
    task?: Task;
    context?: string;
    question?: string;
    messages?: IncomingMessage[];
  };
  const apiKey = body.apiKey?.trim();
  const task = body.task ?? "free";
  const mode = body.mode === "deep" ? "deep" : "fast";
  const context = body.context?.slice(0, 160000) ?? "";
  const question = body.question?.slice(0, 12000) ?? "";
  const messages = (body.messages ?? []).slice(-12).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 16000),
  }));

  if (!apiKey) return NextResponse.json({ error: "请先在设置中输入 DeepSeek API Key。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!question && !context) return NextResponse.json({ error: "没有可供分析的论文内容。" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const userContent = [
    "以下是来自用户本地论文的必要文本。",
    context,
    question ? `\n用户请求：${question}` : "\n请按任务要求完成。",
  ].join("\n");

  try {
    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: true,
        thinking: { type: mode === "deep" ? "enabled" : "disabled" },
        ...(mode === "deep" ? { reasoning_effort: "max" } : {}),
        messages: [
          {
            role: "system",
            content: `你是严谨的计算机科学与技术领域的论文阅读助手，默认用中文回答。${taskInstructions[task]} 不暴露或复述模型内部思考过程。`,
          },
          ...messages,
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "DeepSeek 请求失败，请检查 Key、额度和网络。" }, { status: upstream.status || 502, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(sseTextStream(upstream.body), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform" },
    });
  } catch {
    return NextResponse.json({ error: "无法连接 DeepSeek，请稍后重试。" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
