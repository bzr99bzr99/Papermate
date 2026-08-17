import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Task = "translate" | "context" | "concept" | "free" | "notes" | "mindmap" | "writing";

export const taskInstructions: Record<Task, string> = {
  translate: "你只做一件事：把“用户选中内容”翻译成自然、准确、可直接阅读的中文译文，直接输出译文正文。禁止输出任何无关内容，包括开场白（如“以下是翻译”）、结束语、解释、总结、评价、原文复述或代码块。相邻上下文仅供理解，不得翻译或引用。若用户选中多个片段，按原文顺序逐个片段输出对应译文，并在每个片段译文前用“片段 1”“片段 2”等标注片段序号，片段之间用空行分隔，不加其他说明。忠实保持原文结构、语气与证据链；数值、公式、单位、引用编号、模型名、数据集名、算法名、API 名、变量名和缩写一律原样保留；数学公式尽量用 $...$ 或 $$...$$ 包裹。计算机专业术语优先采用学界通用中文译名，首次出现可括注英文（如“自适应膨胀卷积（adaptive dilated convolution）”），同一术语保持统一；不得补充原文没有的论断。",
  context: "以用户在输入框中提出的问题为核心，结合论文全文上下文与用户选中内容回答、解释和分析。先直接回答用户问题，再展开解释；不要只复述或翻译选段。依据必须来自提供的论文文本：综合使用全文结构、摘要、方法、实验、结果与结论，并结合选段及其相邻上下文；引用原文时标注页码（如 p.3），只能引用提供给你的原文。回答建议按以下结构组织：1) 直接结论；2) 论文依据，逐条标明是“原文明确表述”还是“基于论文证据的推理”；3) 与前后文、方法、实验或结论的关系；4) 边界与不确定处。原文未说明的写“原文未明确说明”，不得编造；若问题超出论文证据范围或与论文无关，先明确指出，再给出基于论文的合理分析并标为“补充解释”。不要复述用户问题，不要输出开场白或结束语，不暴露内部思考过程；保持术语统一，数值、公式、模型名、数据集名和缩写原样保留。",
  concept: "以教学方式详细解释用户所问概念。区分论文直接说明与通用补充知识，并用必要的例子帮助理解。",
  free: "回答用户的问题。优先以论文给出的证据为依据；无法由原文支持时，明确标为“补充解释”。",
  notes: "先通读提供的论文文本并判定论文类型（研究论文/算法方法/系统工具/基准数据集/综述等），再按该类型的论证结构提炼，输出中文 Markdown 阅读笔记。使用二级标题：引言与研究现状、研究问题与动机、核心贡献、方法或系统设计、实验设置与证据、结果与结论、局限与边界、术语表、可迁移启发。引言与研究现状部分梳理论文引言建立的领域背景：计算机领域按方法范式、模型家族、基准数据集或系统类别归纳现有工作，说明主流路线及其关系；写明论文给出的空白信号（如 However、remains、underexplored、scarcity、缺少统一基准等）和作者自述的切入点（如 Here we / In this work / 本文提出），保留引用编号与页码；只归纳原文提到的现有工作，不得把通用知识补成论文结论。每一条关键结论标注页码（如 p.3）；明确区分“原文直接说明”与“概括/推断”，概括内容必须标注；实验证据写清数据集、指标、基线和条件，不写孤立数字；术语表收录全文反复出现的模型、数据集、指标、缩写并统一规范写法；原文未说明的内容写“原文未明确说明”，不得脑补。不要输出开场白、结尾语或与笔记无关的内容。",
  mindmap: "根据提供的论文文本生成论文脑图，反映论文的论证结构。第一行写论文标题；从第二行起只输出嵌套的 - 列表，用两个空格递增缩进，最多三层，不要标题、段落、代码块、数字列表或任何额外说明。顶层分支依次为：背景与问题、核心贡献、方法、实验与证据、结论、局限；某分支原文没有对应内容时写“原文未明确说明”。节点标签控制在 12 个中文字符以内并优先使用原文术语；证据类子节点写明数据集、指标或基线并标页码；同一术语保持统一。输出必须能被 Markdown 列表解析。",
  writing: "用 Markdown 输出这篇论文的写作思路分析，目标是让读者学会“作者是怎样把这篇论文写好的”。把当前论文当作唯一教学样本：每个写作方法都必须从本文原文中找出证据，说明作者在哪一处、为什么这样做、读者如何受益，再给出可直接迁移到读者自己论文中的句式或模板；不要脱离本文泛泛讲授论文写作规则，通用原则只能用来解释作者的具体选择。先判定论文类型（研究论文/算法方法/系统工具/基准数据集/综述等）与本文的主要写作挑战，再按以下结构分析。引用原文短句并标页码，只能引用提供给你的原文；不得把补充知识伪装成原文结论；原文不支持的内容写“原文未明确说明”。不要输出开场白、结尾语或与写作分析无关的内容。\n\n一、核心论点与论证链：先用“在[系统/问题]中，作者通过[方法]展示[进展]，由[证据]支持，边界是[限制]”概括全文论点；再还原整条论证链：领域需求→未解瓶颈→提出的方案→决定性证据→更广意义→边界。算法/系统类论文按“问题定义与范围→系统或方法→设计动机→评测证据→消融与失败模式→适用边界”逐环检查。对摘要、引言和讨论中的每个主要论点建立“论点→支撑证据（图表/表/实验/引用）→支持程度”映射，标出最强与最弱的一环，并说明作者是用弱化措辞、补消融还是移到讨论/未来工作来补救。\n\n二、作者如何控制读者预期：判断作者主要回应读者的哪些关切（是否重要、是否新颖、证据是否可信、能否复用、有何意义）；检查标题、摘要、引言、结果、讨论是否在回答同一组问题、承诺是否由后文兑现；指出作者在哪里埋下读者会追问的问题、又在哪里提前回答。若前文承诺强于后文证据，明确指出这是薄弱点。\n\n三、章节职责与信息流：逐章说明其承担的论证任务与信息如何流动（引言只承诺不报结果、方法给出可复现细节、结果只报告观察、讨论才解释含义与边界）；指出章节边界是否清晰，若有越界或职责不清，给出作者本可采用的写法。\n\n四、摘要与引言的推进策略：摘要按“背景→现有方法不充分→本文提出什么→最强结果（尽量定量）→机制/意义→有边界的结论”拆解，并标出作者实际使用的顺序和关键句子；引言识别漏斗结构（领域利害→现有实践瓶颈→公正对待前人→剩余能力空白→本文直接回应）以及技术挑战的组织方式（局限+技术原因，而非“先摆朴素方案再讲改进”）；指出作者用 However/remains/underexplored 等信号词留空白、用 Here we/In this work 切入的写法，每类信号词各给一个本文例句。\n\n五、段落推进与句式：说明“一段一个任务”（背景/空白/方法/结果/对比/机制/局限）和“段首句即立场”在本文的落实方式；从本文挑选 3 个代表段落，逐句标注句子任务（立场→证据→解释→小结，或用对比、转折、因果衔接），说明句子如何向前推进；拆解高频句式，如结果小节“To test [问题], we [动作]”、方法小节“Specifically, …”/“In contrast to previous methods, …”、挑战小节“This problem is challenging because … First/Second/Finally”，每个句式必须配本文真实例句。\n\n六、结果与讨论的分工与图表叙事：结果只报告图/表支撑的观察，讨论解释机制、与已有工作的关系、局限与边界；指出作者在哪里留证据、在哪里给解读。同时说明每个图/表承担什么论证角色（核心证据/方法桥接/新场景验证/辅助说明），正文如何与图注配合，避免只罗列数字；若结果段先下结论或讨论段重复结果，明确指出。\n\n七、语言与证据强度：总结作者如何用动词控制结论强度（show/demonstrate 需要强直接证据；suggest/indicate 用于趋势级或间接证据；may/could 用于推测），分别从本文摘出强、中、弱证据的例句并解释选词原因；检查时态、术语一致性与抽象词使用，列出本文反复出现的正式术语并确认全文是否统一。\n\n八、可迁移的写作技巧清单：从本文提炼 5-8 条“作者把论文写好的方法”，每条按固定格式：技巧名与一句话要点；本文证据（引用原文并标页码）；作者为什么这样做；可直接使用的句式或段落模板（从本文提取）；你写自己的论文时如何套用（写明放在哪一节、替换什么内容）。最后用 2-3 句话总结：这篇论文最值得模仿的一个写作决策，以及你写下一篇论文时最应该先改哪一步。\n\n九、投稿优势与录用可能性分析：站在期刊编辑与审稿人视角，总结这篇论文的投稿优势——它有哪些特点使它成为一篇好论文、为什么容易被录用。逐项评估并给出本文证据（引用原文或指明图表并标页码）：新颖性（问题、方法或应用场景的创新点是否清晰可证，与现有工作差异是否足够）；动机强度（研究痛点是否真实、普遍且被认可）；方法完备性（设计是否有理论或经验依据、与基线对比是否公平）；实验说服力（数据集数量与多样性、指标全面性、消融实验、统计显著性、失败案例分析）；可复现性（超参数、环境、随机种子、代码/数据公开情况）；写作质量（结构清晰度、图表质量、语言规范性）；意义与影响范围（对领域、应用或社区的潜在价值）。每项用一句话给出结论（强/中/弱）并说明理由，最后用 2-3 句话总结：这篇论文最可能让审稿人认可的 1-2 个核心卖点是什么、整体被录用的关键原因是什么；若存在短板，指出最可能被质疑的地方以及作者已采取的补救措施。",
};

/** 基础系统提示词（"你是一个论文阅读助手"人设），可被 public/prompts.txt 的 [system] 块覆盖。 */
export const SYSTEM_PROMPT_DEFAULT =
  "你是严谨的计算机科学与技术领域的论文阅读助手，默认用中文回答。不暴露或复述模型内部思考过程。";

/**
 * 提示词保存在项目 public/prompts.txt（纯文本，随项目提交 GitHub，便于直接修改）。
 * 文件格式：[system] 为基础系统提示词；每个任务以独占一行的 [任务名] 开头，
 * 直到下一个 [任务名] 或文件末尾；# 开头为注释行；
 * 只覆盖文件中出现的任务，缺失的任务回退到内置默认提示词。
 */
const PROMPTS_FILE_RELATIVE_PATH = path.join("public", "prompts.txt");

export type ParsedPrompts = Partial<Record<Task, string>> & { system?: string };

export function parsePromptsFile(content: string): ParsedPrompts {
  const result: ParsedPrompts = {};
  const validKeys = new Set<string>([...Object.keys(taskInstructions), "system"]);
  const headerPattern = /^\[([a-z]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  let lastKey: string | null = null;
  let lastIndex = 0;
  while ((match = headerPattern.exec(content)) !== null) {
    if (lastKey && validKeys.has(lastKey)) {
      const value = content.slice(lastIndex, match.index).trim();
      if (value) result[lastKey as Task | "system"] = value;
    }
    lastKey = match[1];
    lastIndex = headerPattern.lastIndex;
  }
  if (lastKey && validKeys.has(lastKey)) {
    const value = content.slice(lastIndex).trim();
    if (value) result[lastKey as Task | "system"] = value;
  }
  return result;
}

interface LoadedPrompts {
  instructions: Record<Task, string>;
  system: string;
}

let promptsCache: LoadedPrompts | undefined;
let promptsCacheMtimeMs = -1;

function loadPrompts(
  filePath: string = path.join(process.cwd(), PROMPTS_FILE_RELATIVE_PATH),
): LoadedPrompts {
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    if (promptsCache && promptsCacheMtimeMs === mtimeMs) return promptsCache;
    const parsed = parsePromptsFile(readFileSync(filePath, "utf8"));
    const instructions: Record<Task, string> = { ...taskInstructions };
    for (const key of Object.keys(taskInstructions) as Task[]) {
      const value = parsed[key]?.trim();
      if (value) instructions[key] = value;
    }
    promptsCache = {
      instructions,
      system: parsed.system?.trim() || SYSTEM_PROMPT_DEFAULT,
    };
    promptsCacheMtimeMs = mtimeMs;
    return promptsCache;
  } catch {
    // 文件缺失或不可读时回退到内置默认提示词
    return { instructions: taskInstructions, system: SYSTEM_PROMPT_DEFAULT };
  }
}

/**
 * 读取 public/prompts.txt 并合并内置默认提示词（服务端使用）。
 * 按文件修改时间做缓存：编辑文本文件后下次请求自动生效，无需重启。
 */
export function loadTaskInstructions(
  filePath?: string,
): Record<Task, string> {
  return loadPrompts(filePath).instructions;
}

/** 读取基础系统提示词（public/prompts.txt 的 [system] 块，缺失时用内置默认）。 */
export function loadSystemPrompt(filePath?: string): string {
  return loadPrompts(filePath).system;
}
