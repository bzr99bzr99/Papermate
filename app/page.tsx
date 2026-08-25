"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bot,
  Bookmark,
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  MessageCircleMore,
  Moon,
  Network,
  Palette,
  PanelLeftClose,
  PanelRightClose,
  Pin,
  Plus,
  Quote,
  RefreshCw,
  Search,
  SendHorizonal,
  Settings2,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  PdfReader,
  type ConversationFocusRequest,
  parsePdfFile,
  repairPaperOriginalMetadata,
} from "@/components/pdf-reader";
import BuddySystem from "@/components/buddy-system";
import {
  deletePaper,
  deleteCustomModel,
  exportBackup,
  fetchDiskBackup,
  findPaperBySourceHash,
  getApiKeys,
  getPaper,
  getSettings,
  getWorkspace,
  importBackup,
  listModels,
  listPapers,
  lookupPaperMetadata,
  reorderPapers,
  saveApiKeys,
  saveCustomModel,
  saveSettings,
  savePaper,
  saveWorkspace,
  setPaperPinned,
  updatePaperNote,
} from "@/lib/db";
import { buildBackup, isBackup, type BackupSettings } from "@/lib/backup";
import * as legacyDb from "@/lib/legacy-idb";
import {
  isWeakPaperTitle,
  type PaperMetadataBlockInput,
  type PaperMetadataPatch,
} from "@/lib/paper-metadata";
import {
  anchorExcerptParts,
  buildContext,
  buildPaperDigest,
  defaultHighlightColor,
  deriveHighlightRegions,
  HIGHLIGHT_COLORS,
  MAX_SELECTION_FRAGMENTS,
  pagesHaveSelectableText,
  selectionGroupForAnchors,
} from "@/lib/pdf";
import { markdownToMindMap, mindMapToSvg } from "@/lib/mindmap";
import { loadReaderQuotes, READER_QUOTES } from "@/lib/quotes";
import { blobSha256 } from "@/lib/source-hash";
import {
  BUILTIN_MODEL_IDS,
  BUILTIN_MODELS,
  CUSTOM_MODEL_BADGE,
  mergeModelOptions,
  validateCustomModel,
  type BuiltinModelId,
  type ClientModelOption,
  type CustomModelConfig,
} from "@/lib/models";
import type {
  ArtifactKind,
  ArtifactVersion,
  ChatTurn,
  Conversation,
  GeneratedArtifact,
  HighlightColor,
  ModelMode,
  ModelProvider,
  Paper,
  PaperMeta,
  PaperWorkspace,
  PromptKind,
  SelectionGroup,
  TextAnchor,
} from "@/lib/types";

type RightView = "chat" | ArtifactKind;
type KeyState = "idle" | "testing" | "valid" | "invalid";

const THEME_KEY = "papermate-theme-v1";
const LAYOUT_KEY = "papermate-layout-v1";
const BACKUP_FILE_PATH = "data/papermate-backup.json";

/* ---------- 模型选择：内置 4 个模型 + 用户在设置中添加的自定义模型；快速/深度按钮只切换“思考”开关，不换模型 ---------- */
const MODEL_KEY = "papermate-model-v1";
const DEFAULT_MODEL_ID = "glm-flash" as BuiltinModelId;
function loadModelId(): string {
  try {
    const saved = window.localStorage.getItem(MODEL_KEY);
    // 内置 id 直接可用；自定义模型 id 在列表加载完成后再校验（此处只处理内置）。
    if (saved && (BUILTIN_MODEL_IDS as readonly string[]).includes(saved)) return saved;
  } catch {
    /* 忽略 */
  }
  return DEFAULT_MODEL_ID;
}
type ThemeId = "classic" | "paper-white" | "bean-green" | "parchment" | "dark" | "cyberpunk" | "mono" | "academic-blue" | "morandi" | "noble" | "classified" | "eink" | "grimoire" | "arcade" | "vinyl" | "hud" | "red-china" | "pixel" | "guofeng" | "inkwash";
const THEME_IDS: ThemeId[] = ["classic", "paper-white", "bean-green", "parchment", "dark", "cyberpunk", "mono", "academic-blue", "morandi", "noble", "classified", "eink", "grimoire", "arcade", "vinyl", "hud", "red-china", "pixel", "guofeng", "inkwash"];
type ThemeOption = {
  id: ThemeId;
  name: string;
  description: string;
  swatch: CSSProperties;
};
const THEMES: ThemeOption[] = [
  { id: "classic", name: "经典原版", description: "保留现有绿色系阅读界面", swatch: { background: "linear-gradient(135deg, #f8f7f3 0%, #24453c 100%)" } },
  { id: "paper-white", name: "类纸护眼白", description: "暖白背景 + 深灰文字，模拟打印纸质感", swatch: { background: "linear-gradient(135deg, #f6f3ec 0%, #4f5b50 100%)" } },
  { id: "bean-green", name: "豆沙绿护眼", description: "经典豆沙绿底 + 深色文字，降低屏幕刺激", swatch: { background: "linear-gradient(135deg, #c9d8c4 0%, #3e5c3d 100%)" } },
  { id: "parchment", name: "羊皮纸复古", description: "米黄做旧底色 + 棕色文字，像旧书页", swatch: { background: "linear-gradient(135deg, #e6d9bd 0%, #6f4e2f 100%)" } },
  { id: "dark", name: "深色护眼", description: "深灰底 + 浅灰文字，适合夜间或暗环境阅读", swatch: { background: "linear-gradient(135deg, #1f2120 0%, #7fae8f 100%)" } },
  { id: "cyberpunk", name: "赛博朋克", description: "黑紫底 + 霓虹粉/蓝点缀，标题和边框发光", swatch: { background: "linear-gradient(135deg, #150a24 0%, #00e5ff 52%, #ff2fd6 100%)" } },
  { id: "mono", name: "极简黑白", description: "纯白底 + 纯黑文字，无干扰，信息密度高", swatch: { background: "linear-gradient(135deg, #ffffff 0%, #000000 100%)" } },
  { id: "academic-blue", name: "深蓝学术", description: "深蓝底 + 浅色文字 + 金色标题，庄重典雅", swatch: { background: "linear-gradient(135deg, #0e1f38 0%, #d3a845 100%)" } },
  { id: "morandi", name: "莫兰迪灰", description: "低饱和灰调背景 + 柔和文字色，高级耐看", swatch: { background: "linear-gradient(135deg, #d8d8d2 0%, #7d8278 100%)" } },
  { id: "noble", name: "高贵典雅", description: "深墨绿底 + 香槟金标题 + 米白正文，庄重华丽", swatch: { background: "linear-gradient(135deg, #15241d 0%, #c8a24b 100%)" } },
  { id: "classified", name: "机密绝密档案", description: "牛皮纸档案袋 + 印章红 + 打字机质感，绝密文件柜", swatch: { background: "linear-gradient(135deg, #e8e0cd 0%, #9e1b1b 100%)" } },
  { id: "eink", name: "电子墨水拟真", description: "纯黑白灰无彩色，模拟墨水屏纸感，专注无干扰", swatch: { background: "linear-gradient(135deg, #f7f7f5 0%, #111111 100%)" } },
  { id: "grimoire", name: "中世纪魔法典籍", description: "暗羊皮纸 + 金箔文字 + 暗红点缀，魔典书卷氛围", swatch: { background: "linear-gradient(135deg, #241a12 0%, #c9a24b 100%)" } },
  { id: "arcade", name: "街机像素风", description: "深紫底 + 霓虹青/品红辉光 + 扫描线，街机厅氛围", swatch: { background: "linear-gradient(135deg, #14081f 0%, #3df2ff 52%, #ff3df2 100%)" } },
  { id: "vinyl", name: "复古黑胶唱片册", description: "暖黑底 + 琥珀金线 + 唱盘圆徽，老唱机氛围", swatch: { background: "linear-gradient(135deg, #1d1613 0%, #d4a03c 100%)" } },
  { id: "hud", name: "太空舱 HUD 界面", description: "深空蓝黑 + 青色 HUD 发光 + 网格线，飞船仪表舱", swatch: { background: "linear-gradient(135deg, #060d1a 0%, #35e0c0 100%)" } },
  { id: "red-china", name: "红色中国风", description: "宣纸米底 + 中国红 + 鎏金点缀，东方典藏气质", swatch: { background: "linear-gradient(135deg, #f3ede1 0%, #b52b2b 100%)" } },
  { id: "pixel", name: "黑白像素风", description: "黑白灰高对比 + 像素颗粒锯齿 + 红黄点缀，复古硬朗", swatch: { background: "linear-gradient(135deg, #e8e8e8 0%, #000000 52%, #ffd400 100%)" } },
  { id: "guofeng", name: "中国古风", description: "墨色山水 + 青绿点缀 + 朱砂印章，水墨丹青东方意境", swatch: { background: "linear-gradient(135deg, #171d19 0%, #5c8f78 55%, #c24b3f 100%)" } },
  { id: "inkwash", name: "中国水墨古风", description: "宣纸米底 + 浓淡墨色 + 朱砂印章，水墨留白意境", swatch: { background: "linear-gradient(135deg, #f2efe6 0%, #4a4a44 60%, #b23a2e 100%)" } },
];

const blankWorkspace: PaperWorkspace = { annotations: [], conversations: [], artifacts: [] };
// 每类成果最多保留的历史版本数（超出时丢弃最旧的）。
const MAX_ARTIFACT_VERSIONS = 20;
const artifactDetails: Record<ArtifactKind, { title: string; description: string; icon: typeof FileText }> = {
  notes: { title: "阅读笔记", description: "提炼问题、贡献、方法、证据与启发", icon: FileText },
  mindmap: { title: "论文脑图", description: "用可折叠的论证结构理解全篇", icon: Network },
  writing: { title: "写作思路", description: "以本文为样本，学习作者的写作方法与技巧", icon: WandSparkles },
};

const promptLabels: Record<PromptKind, string> = {
  translate: "翻译",
  context: "结合上下文解释",
  concept: "详细讲解",
  free: "自由提问",
};

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// GLM 免费档对同一账号并发有限，采用全局单任务：一次只允许一个问答/生成任务，
// 执行期间其他提交按钮禁用；DeepSeek 无并发限制，保持原有并行逻辑。

// 对可重试的上游错误（超时/5xx）做带退避的自动重试，避免瞬时限流直接报失败；
// 429 由服务端 /api/chat 内部做长退避重试（覆盖 GLM 免费档约 20 秒的冷却窗口），
// 客户端不再重复重试，避免叠加等待。
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const response = await fetch(url, init);
    const retryable =
      response.status === 408 ||
      response.status >= 500;
    if (!retryable) return response;
    lastResponse = response;
    if (attempt < retries - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  return lastResponse ?? new Response(null, { status: 502 });
}

function readableDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function readableDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function paperToMeta(paper: Paper): PaperMeta {
  return {
    id: paper.id,
    title: paper.title,
    fileName: paper.fileName,
    sourceHash: paper.sourceHash,
    note: paper.note,
    keywords: paper.keywords,
    journal: paper.journal,
    impactFactor: paper.impactFactor,
    pinned: paper.pinned,
    createdAt: paper.createdAt,
    updatedAt: paper.updatedAt,
    pageCount: paper.pageCount,
    originalReady: paper.originalReady,
  };
}

function firstPageMetadataBlocks(
  pages: Array<{
    blocks: Array<{ text: string; fontSize?: number; top: number; kind?: string }>;
    height?: number;
  }>,
): { blocks: PaperMetadataBlockInput[]; pageHeight?: number } {
  const page = pages[0];
  const height = page?.height;
  return {
    blocks:
      page?.blocks
        .slice(0, 80)
        .map((block) => ({
          text: block.text,
          fontSize: block.fontSize,
          top:
            height && Number.isFinite(block.top)
              ? Math.max(0, Math.min(height, height - block.top))
              : block.top,
          kind: block.kind,
        })) ?? [],
    pageHeight: height,
  };
}

function debounce(fn: () => void | Promise<void>, delay: number) {
  let timer: number | undefined;
  let inFlight: Promise<void> | undefined;
  const run = () => {
    const next = Promise.resolve(fn()).catch(() => {});
    inFlight = next;
    void next.finally(() => {
      if (inFlight === next) inFlight = undefined;
    });
  };
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      run();
    }, delay);
  };
  const flush = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
      run();
    }
    return inFlight ?? Promise.resolve();
  };
  return { schedule, flush };
}

function isNormalScope(conversation: Conversation): boolean {
  return (conversation.scope ?? "normal") === "normal";
}

function normalizedQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 一条提问记录对应的原文引文（取首个片段），用于同内容去重。 */
function turnQuote(turn: ChatTurn): string {
  const anchor = turn.selection?.anchors[0] ?? turn.anchor;
  return anchor ? normalizedQuote(anchor.quote) : "";
}

function conversationMatchesSelection(
  conversation: Conversation,
  selection?: SelectionGroup,
  anchor?: TextAnchor,
): boolean {
  if (selection) {
    return (
      conversation.selection?.id === selection.id ||
      conversation.anchor?.id === selection.anchors[0]?.id
    );
  }
  return anchor ? conversation.anchor?.id === anchor.id : false;
}

function buildContextHistoryMessages(turns: ChatTurn[], fullDigest: string) {
  const firstContextIndex = turns.findIndex(
    (turn) => turn.role === "user" && turn.kind === "context",
  );
  if (firstContextIndex < 0) {
    return turns.slice(-10).map((turn) => ({ role: turn.role, content: turn.content }));
  }
  const first = turns[firstContextIndex];
  const tail = turns.slice(-9);
  if (!tail.some((turn) => turn.id === first.id)) tail.unshift(first);
  return tail.map((turn) => ({
    role: turn.role,
    content:
      turn.id === first.id && fullDigest.trim()
        ? `${turn.content}\n\n[论文全文摘要与结构]\n${fullDigest}`
        : turn.content,
  }));
}

function downloadFile(name: string, content: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** 派发陪读小人动作事件（buddy-system 组件监听后按人格回应）。
 *  payload：场景补充内容——问答/翻译传“原文选段+提问+回答”，成果生成传“论文摘要”。 */
function buddyEvent(type: string, title?: string, payload?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("papermate-buddy-event", { detail: { type, title, payload } }),
  );
}

async function copyTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (copied) return;
  if (navigator.clipboard?.writeText) {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard-timeout")), 800)),
    ]);
    return;
  }
  throw new Error("copy-failed");
}

function documentContext(paper: Paper) {
  const text = paper.pages
    .map((page) => `\n[第 ${page.page} 页]\n${page.text}`)
    .join("\n");
  return text.length <= 155000 ? text : `${text.slice(0, 115000)}\n\n[中间内容因长度省略]\n\n${text.slice(-40000)}`;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [papers, setPapers] = useState<PaperMeta[]>([]);
  const [paper, setPaper] = useState<Paper>();
  const [activeChapter, setActiveChapter] = useState<{ sectionId?: string; page?: number }>({});
  const [chapterScrollRequest, setChapterScrollRequest] = useState<{
    page: number;
    sectionId: string;
    nonce: number;
  }>();
  const [workspace, setWorkspace] = useState<PaperWorkspace>(blankWorkspace);
  const [activeAnchors, setActiveAnchors] = useState<TextAnchor[]>([]);
  const [rightView, setRightView] = useState<RightView>("chat");
  const [apiKey, setApiKey] = useState("");
  const [glmApiKey, setGlmApiKey] = useState("");
  const [kimiApiKey, setKimiApiKey] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>("classic");
  const [keyState, setKeyState] = useState<KeyState>("idle");
  const [glmKeyState, setGlmKeyState] = useState<KeyState>("idle");
  const [kimiKeyState, setKimiKeyState] = useState<KeyState>("idle");
  const [modelId, setModelId] = useState<string>(() => loadModelId());
  // 自定义模型（设置中添加）：下拉与问答/生成共用。
  const [allModels, setAllModels] = useState<ClientModelOption[]>(() =>
    mergeModelOptions(BUILTIN_MODELS, []),
  );
  const [customModels, setCustomModels] = useState<CustomModelConfig[]>([]);
  // 快速/深度独立状态：只切换当前模型的“思考”开关，不切换模型
  const [mode, setMode] = useState<ModelMode>("fast");
  const modelProvider: ModelProvider =
    allModels.find((item) => item.id === modelId)?.provider ?? "deepseek";
  /** 选择下拉模型：只改模型，不重置思考开关 */
  function changeModelId(next: string) {
    setModelId(next);
    try {
      window.localStorage.setItem(MODEL_KEY, next);
    } catch {
      /* 忽略 */
    }
  }
  /** 刷新模型列表（内置 + 自定义），供下拉与设置页使用 */
  const modelsReadyRef = useRef(false);
  const refreshModels = useCallback(async () => {
    try {
      const registry = await listModels();
      setAllModels(registry.models);
      setCustomModels(registry.custom);
      modelsReadyRef.current = true;
    } catch {
      // 读取失败时保留现有列表（内置模型仍可用）。
    }
  }, []);
  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);
  useEffect(() => {
    if (settingsOpen) void refreshModels();
  }, [settingsOpen, refreshModels]);
  // 模型列表加载完成后，若当前选中的模型不存在（已被删除等）则回退默认模型。
  useEffect(() => {
    if (!modelsReadyRef.current) return;
    if (!allModels.some((item) => item.id === modelId)) {
      changeModelId(DEFAULT_MODEL_ID);
    }
  }, [allModels, modelId]);

  /** 保存（新增/更新）自定义模型 */
  async function handleSaveCustomModel(model: CustomModelConfig) {
    try {
      const saved = await saveCustomModel(model);
      setNotice(saved ? `模型「${saved.name}」已保存。` : undefined);
      await refreshModels();
      return { ok: true as const };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "自定义模型保存失败。");
      return { ok: false as const };
    }
  }

  /** 删除自定义模型 */
  async function handleDeleteCustomModel(id: string) {
    try {
      await deleteCustomModel(id);
      if (modelId === id) changeModelId(DEFAULT_MODEL_ID);
      setNotice("已删除该自定义模型。");
      await refreshModels();
      return { ok: true as const };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "自定义模型删除失败。");
      return { ok: false as const };
    }
  }

  /** 测试自定义模型连接（已保存模型按 modelId，草稿按表单 url/modelName） */
  async function handleTestCustomModel(input: {
    modelId?: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
  }) {
    try {
      const response = await fetch("/api/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: input.modelId,
          url: input.baseUrl,
          modelName: input.model,
          apiKey: input.apiKey,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "连接失败。");
      }
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : "连接失败。" };
    }
  }
  /** 点击快速/深度按钮：仅切换当前模型的思考开关（快速=非思考，深度=思考） */
  function changeMode(next: ModelMode) {
    setMode(next);
  }
  const [question, setQuestion] = useState("");
  const [runningKinds, setRunningKinds] = useState<Set<string>>(new Set());
  const [noticeKinds, setNoticeKinds] = useState<Set<string>>(new Set());
  const runningKindsRef = useRef<Set<string>>(new Set());
  const rightViewRef = useRef<RightView>("chat");
  rightViewRef.current = rightView;
  const taskPaperRef = useRef<Record<string, string>>({});
  const [contextMode, setContextMode] = useState(false);
  // 翻译模式：开启后划选原文立即翻译，并保持按钮选中状态。
  const [translateMode, setTranslateMode] = useState(false);
  const [pendingColor, setPendingColor] = useState<HighlightColor>(HIGHLIGHT_COLORS[0]);
  const [uploadState, setUploadState] = useState<"idle" | "loading" | "error">("idle");
  const [backfillingId, setBackfillingId] = useState<string>();
  // 陪读小人显示/隐藏（隐藏后完全卸载，不再说话、不再请求模型）
  const [buddyVisible, setBuddyVisible] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("papermate-buddy-visible-v1") !== "0";
    } catch {
      return true;
    }
  });
  function toggleBuddyVisible() {
    const next = !buddyVisible;
    setBuddyVisible(next);
    try {
      window.localStorage.setItem("papermate-buddy-visible-v1", next ? "1" : "0");
    } catch {
      /* 忽略 */
    }
    setNotice(next ? "陪读小人已显示。" : "陪读小人已隐藏，将不再打扰你。");
  }
  const [notice, setNotice] = useState<string>();
  // 生成/发送失败时的警示弹层（可复制、可关闭，不遮挡阅读）。
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);
  // 删除成果/历史版本的自定义确认弹窗（替代浏览器原生 confirm）。
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "artifact"; kind: ArtifactKind }
    | { type: "version"; kind: ArtifactKind; versionId: string }
    | null
  >(null);
  // 确认弹窗：Esc 关闭
  useEffect(() => {
    if (!deleteConfirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteConfirm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteConfirm]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [dragPaperId, setDragPaperId] = useState<string>();
  const [dragOverId, setDragOverId] = useState<string>();
  const [editingNotePaperId, setEditingNotePaperId] = useState<string>();
  const [noteDraft, setNoteDraft] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [conversationFocusRequest, setConversationFocusRequest] = useState<ConversationFocusRequest>();
  const [isCompact, setIsCompact] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [leftWidth, setLeftWidth] = useState(224);
  const [rightWidth, setRightWidth] = useState(382);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [backupState, setBackupState] = useState<"idle" | "saving" | "saved" | "error" | "restoring">("idle");
  const [backupSavedAt, setBackupSavedAt] = useState<string>();
  const [backupFilePath, setBackupFilePath] = useState(BACKUP_FILE_PATH);
  const themeRef = useRef<ThemeId>("classic");
  themeRef.current = theme;
  const layoutRef = useRef({ leftWidth, rightWidth, leftCollapsed, rightCollapsed });
  layoutRef.current = { leftWidth, rightWidth, leftCollapsed, rightCollapsed };
  const settingsLoadedRef = useRef(false);
  const pendingWorkspaceRef = useRef<PaperWorkspace | null>(null);
  const workspaceRef = useRef<PaperWorkspace>(blankWorkspace);
  workspaceRef.current = workspace;
  const runningChatIdsRef = useRef<Set<string>>(new Set());
  const [runningChatIds, setRunningChatIds] = useState<ReadonlySet<string>>(new Set());
  const deletedConversationIdsRef = useRef<Set<string>>(new Set());
  const paperIdRef = useRef<string | undefined>(paper?.id);
  paperIdRef.current = paper?.id;
  // API Key 持久化：从 data/apikey.txt 读取，修改后防抖写回。
  const keysLoadedRef = useRef(false);
  const loadedKeysRef = useRef<{ deepseek: string; glm: string; kimi: string }>({
    deepseek: "",
    glm: "",
    kimi: "",
  });
  // DeepSeek / Kimi 支持并发对话：多个会话可同时流式生成；GLM 免费档保持单任务。
  const beginChat = useCallback((conversationId: string) => {
    runningChatIdsRef.current = new Set(runningChatIdsRef.current).add(conversationId);
    setRunningChatIds(new Set(runningChatIdsRef.current));
    setRunningKinds((prev) => new Set(prev).add("chat"));
  }, []);
  const endChat = useCallback((conversationId: string) => {
    const next = new Set(runningChatIdsRef.current);
    next.delete(conversationId);
    runningChatIdsRef.current = next;
    setRunningChatIds(next);
    if (next.size === 0) {
      finishKind("chat", paperIdRef.current);
    }
  }, []);

  useEffect(() => {
    setNoticeKinds(new Set());
  }, [paper?.id]);
  const saveWorkspaceDebouncer = useMemo(
    () =>
      debounce(() => {
        const id = paperIdRef.current;
        const next = pendingWorkspaceRef.current;
        if (!id || !next) return;
        pendingWorkspaceRef.current = null;
        return saveWorkspace(id, next).catch(() => setNotice("本地成果保存失败。"));
      }, 300),
    [],
  );

  // 关闭/切换页面时兜底保存：提问、标注等成果是防抖（300ms）落盘，
  // 在防抖窗口内直接关闭页面可能丢失最后一次写入，这里用 keepalive 尽力补写。
  useEffect(() => {
    const flushOnExit = () => {
      const id = paperIdRef.current;
      const next = pendingWorkspaceRef.current;
      if (!id || !next) return;
      void saveWorkspace(id, next, true).catch(() => {});
    };
    window.addEventListener("pagehide", flushOnExit);
    window.addEventListener("beforeunload", flushOnExit);
    return () => {
      window.removeEventListener("pagehide", flushOnExit);
      window.removeEventListener("beforeunload", flushOnExit);
    };
  }, []);
  const activeAnchor = activeAnchors[0];
  const activeSelection = useMemo(
    () => selectionGroupForAnchors(paper?.id ?? "", activeAnchors),
    [activeAnchors, paper?.id],
  );
  const highlightRegions = useMemo(
    () => deriveHighlightRegions(workspace.conversations),
    [workspace.conversations],
  );
  const paperDigest = useMemo(
    () => (paper ? buildPaperDigest(paper.pages, paper.outline ?? [], paper.title) : ""),
    [paper],
  );
  const visiblePapers = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    if (!query) return papers;
    return papers.filter((item) =>
      [
        item.title,
        item.fileName,
        item.note ?? "",
        item.keywords?.join(" ") ?? "",
        item.journal ?? "",
        item.impactFactor ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [libraryQuery, papers]);

  const writeBackupNow = useCallback(async () => {
    await saveWorkspaceDebouncer.flush();
    setBackupState("saving");
    try {
      const result = await fetch("/api/storage/backup", { method: "POST" });
      if (!result.ok) throw new Error("backup-write-failed");
      const data = (await result.json()) as { savedAt?: string; filePath?: string };
      if (data.savedAt) setBackupSavedAt(data.savedAt);
      if (data.filePath) setBackupFilePath(data.filePath);
      setBackupState("saved");
      setNotice("已生成完整 JSON 备份文件。");
    } catch {
      setBackupState("error");
      setNotice("本机磁盘备份失败，请检查磁盘空间或读写权限。");
    }
  }, [saveWorkspaceDebouncer]);

  const applyBackupSettings = useCallback((settings?: BackupSettings) => {
    if (!settings) return;
    if (typeof settings.theme === "string" && THEME_IDS.includes(settings.theme as ThemeId)) {
      setTheme(settings.theme as ThemeId);
    }
    const layout = settings.layout;
    if (!layout) return;
    if (typeof layout.leftWidth === "number") setLeftWidth(Math.min(420, Math.max(170, layout.leftWidth)));
    if (typeof layout.rightWidth === "number") setRightWidth(Math.min(620, Math.max(300, layout.rightWidth)));
    setLeftCollapsed(Boolean(layout.leftCollapsed));
    setRightCollapsed(Boolean(layout.rightCollapsed));
  }, []);

  async function restoreFromBackup() {
    if (!window.confirm("从本机备份恢复会覆盖当前论文库，确定继续吗？")) return;
    await saveWorkspaceDebouncer.flush();
    setBackupState("restoring");
    try {
      const disk = await fetchDiskBackup(true);
      const backup = disk.backup;
      if (!backup) throw new Error("backup-missing");
      await importBackup(backup);
      const restored = await listPapers();
      setPapers(restored);
      setPaper(undefined);
      setBackupSavedAt(disk.savedAt || backup.savedAt || undefined);
      if (disk.filePath) setBackupFilePath(disk.filePath);
      applyBackupSettings(backup.settings);
      setNotice(
        restored.length || backup.workspaces.length
          ? `已从本机磁盘备份恢复 ${restored.length} 篇论文。`
          : "备份文件为空，论文库已清空。",
      );
      setBackupState("saved");
    } catch {
      setBackupState("error");
      setNotice("无法从本机磁盘备份恢复。");
    }
  }

  async function exportBackupFile() {
    setBackupState("saving");
    try {
      const backup = await exportBackup();
      const stamp = (backup.savedAt || new Date().toISOString()).slice(0, 10);
      downloadFile(
        `papermate-backup-${stamp}.json`,
        JSON.stringify(backup, null, 2),
        "application/json",
      );
      setNotice(`已导出 ${backup.papers.length} 篇论文的备份文件，可复制到其他项目后导入。`);
      setBackupState("saved");
    } catch {
      setBackupState("error");
      setNotice("导出备份失败，请稍后重试。");
    }
  }

  async function importBackupFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setNotice("请选择 .json 备份文件。");
      return;
    }
    if (!window.confirm("导入备份会覆盖当前论文库，确定继续吗？")) return;
    await saveWorkspaceDebouncer.flush();
    setBackupState("restoring");
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isBackup(parsed)) throw new Error("invalid-backup");
      await importBackup(parsed);
      const restored = await listPapers();
      setPapers(restored);
      setPaper(undefined);
      setBackupSavedAt(parsed.savedAt || new Date().toISOString());
      applyBackupSettings(parsed.settings);
      setNotice(`已从备份文件导入 ${restored.length} 篇论文和本地成果。`);
      setBackupState("saved");
    } catch {
      setBackupState("error");
      setNotice("无法导入备份：文件不是有效的 PaperMate 备份。");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [stored, disk] = await Promise.all([
          listPapers(),
          fetchDiskBackup(false).catch(() => undefined),
        ]);
        let current = stored;
        if (!current.length) {
          try {
            const [legacyPapers, legacyWorkspaces] = await Promise.all([
              legacyDb.listPapers(),
              legacyDb.listWorkspaces(),
            ]);
            if (legacyPapers.length || legacyWorkspaces.length) {
              const legacyBackup = await buildBackup(legacyPapers, legacyWorkspaces);
              await importBackup(legacyBackup);
              current = await listPapers();
              if (!cancelled) {
                setNotice(`已将旧版浏览器论文库迁移 ${current.length} 篇论文。`);
              }
            }
          } catch {
            // 旧版 IndexedDB 不存在或已清空时无需迁移
          }
        }
        const settings = await getSettings().catch(() => ({}));
        if (cancelled) return;
        setPapers(current);
        if (disk?.filePath) setBackupFilePath(disk.filePath);
        if (disk?.savedAt) setBackupSavedAt(disk.savedAt);
        applyBackupSettings(settings);
        settingsLoadedRef.current = true;
        // 读取 data/apikey.txt 中持久化的 API Key（失败时保持空值，不阻断启动）。
        const keys = await getApiKeys().catch(
          (): { deepseek?: string; glm?: string; kimi?: string } => ({}),
        );
        if (cancelled) return;
        loadedKeysRef.current = {
          deepseek: keys.deepseek ?? "",
          glm: keys.glm ?? "",
          kimi: keys.kimi ?? "",
        };
        keysLoadedRef.current = true;
        setApiKey(loadedKeysRef.current.deepseek);
        setGlmApiKey(loadedKeysRef.current.glm);
        setKimiApiKey(loadedKeysRef.current.kimi);
      } catch {
        settingsLoadedRef.current = true;
        if (!cancelled) setNotice("无法打开本地论文库。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBackupSettings]);

  // 把当前输入的 API Key 写回 data/apikey.txt；与已保存值相同则跳过（避免启动时多写一次）。
  // 提问前也会主动调用一次，保证服务端从文件读到的是最新 Key。
  const persistApiKeys = useCallback(() => {
    if (!keysLoadedRef.current) return Promise.resolve();
    if (
      apiKey === loadedKeysRef.current.deepseek &&
      glmApiKey === loadedKeysRef.current.glm &&
      kimiApiKey === loadedKeysRef.current.kimi
    ) {
      return Promise.resolve();
    }
    loadedKeysRef.current = { deepseek: apiKey, glm: glmApiKey, kimi: kimiApiKey };
    return saveApiKeys({ deepseek: apiKey, glm: glmApiKey, kimi: kimiApiKey }).catch(() =>
      setNotice("API Key 保存失败。"),
    );
  }, [apiKey, glmApiKey, kimiApiKey]);

  // API Key 修改后防抖写回 data/apikey.txt。
  useEffect(() => {
    if (!keysLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void persistApiKeys();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [apiKey, glmApiKey, kimiApiKey, persistApiKeys]);

  // 设置面板打开时，从 data/apikey.txt 重新读取（外部手工增删改也能同步到界面）。
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    void getApiKeys()
      .catch((): { deepseek?: string; glm?: string; kimi?: string } => ({}))
      .then((keys) => {
        if (cancelled) return;
        loadedKeysRef.current = {
          deepseek: keys.deepseek ?? "",
          glm: keys.glm ?? "",
          kimi: keys.kimi ?? "",
        };
        keysLoadedRef.current = true;
        setApiKey(loadedKeysRef.current.deepseek);
        setGlmApiKey(loadedKeysRef.current.glm);
        setKimiApiKey(loadedKeysRef.current.kimi);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  // 关闭设置时立即把增删改同步写回 data/apikey.txt（不等 600ms 防抖）。
  const closeSettings = useCallback(() => {
    void persistApiKeys();
    setSettingsOpen(false);
  }, [persistApiKeys]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY) as ThemeId | null;
      if (saved && THEME_IDS.includes(saved)) setTheme(saved);
    } catch {
      // 主题设置损坏时忽略
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage 不可用时忽略主题持久化
    }
    if (settingsLoadedRef.current) {
      void saveSettings({ theme, layout: layoutRef.current }).catch(() =>
        setNotice("界面设置保存失败。"),
      );
    }
  }, [theme]);

  useEffect(() => {
    const compactMedia = window.matchMedia("(max-width: 1060px)");
    const mobileMedia = window.matchMedia("(max-width: 820px)");
    const update = () => {
      setIsCompact(compactMedia.matches);
      setIsMobile(mobileMedia.matches);
    };
    update();
    compactMedia.addEventListener("change", update);
    mobileMedia.addEventListener("change", update);
    return () => {
      compactMedia.removeEventListener("change", update);
      mobileMedia.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ leftWidth, rightWidth, leftCollapsed, rightCollapsed }),
      );
    } catch {
      // localStorage 不可用时忽略布局持久化
    }
    if (settingsLoadedRef.current) {
      void saveSettings({
        theme: themeRef.current,
        layout: { leftWidth, rightWidth, leftCollapsed, rightCollapsed },
      }).catch(() => setNotice("界面设置保存失败。"));
    }
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    saveWorkspaceDebouncer.flush();
    setActiveAnchors([]);
    setActiveConversationId(undefined);
    setContextMode(false);
    if (!paper) {
      setWorkspace(blankWorkspace);
      return;
    }
    setPendingColor(defaultHighlightColor(0));
    setWorkspace(blankWorkspace);
    void getWorkspace(paper.id)
      .then((loaded) => {
        if (paperIdRef.current === paper.id) setWorkspace(loaded);
      })
      .catch(() => setNotice("无法读取这篇论文的本地笔记。"));
  }, [paper, saveWorkspaceDebouncer]);

  useEffect(
    () => () => {
      saveWorkspaceDebouncer.flush();
    },
    [saveWorkspaceDebouncer],
  );

  const onActiveChapterChange = useCallback(
    (next: { sectionId?: string; page?: number }) => {
      setActiveChapter(next);
    },
    [],
  );

  const selectedConversation = useMemo(() => {
    const byId = workspace.conversations.find((conversation) => conversation.id === activeConversationId);
    if (byId) return byId;
    if (activeSelection) {
      return workspace.conversations.find(
        (conversation) =>
          isNormalScope(conversation) &&
          conversationMatchesSelection(conversation, activeSelection),
      ) ?? workspace.conversations.find(
        (conversation) => conversationMatchesSelection(conversation, activeSelection),
      );
    }
    return workspace.conversations.find(
      (conversation) =>
        isNormalScope(conversation) &&
        conversationMatchesSelection(conversation, undefined, activeAnchor),
    ) ??
      workspace.conversations.find(
        (conversation) => conversationMatchesSelection(conversation, undefined, activeAnchor),
      ) ??
      workspace.conversations.find((conversation) => isNormalScope(conversation)) ??
      workspace.conversations.at(0);
  }, [activeAnchor, activeConversationId, activeSelection, workspace.conversations]);

  function commitWorkspace(next: PaperWorkspace) {
    setWorkspace(next);
    workspaceRef.current = next;
    pendingWorkspaceRef.current = next;
    if (paperIdRef.current) saveWorkspaceDebouncer.schedule();
  }

  function startResize(which: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (isCompact || isMobile) return;
    event.preventDefault();
    const startX = event.clientX;
    // 折叠的侧边栏按 0 宽参与拖动：拖动另一边时折叠栏不得“复活”遮挡内容。
    const startLeft = leftCollapsed ? 0 : leftWidth;
    const startRight = rightCollapsed ? 0 : rightWidth;
    // 拖动期间直接改 grid 的样式（CSS 变量驱动网格列宽与拖拽手柄位置），
    // 不触发 React 渲染，避免阅读器逐帧重排与逐帧重绘 PDF；松手时一次性提交。
    // 同时通过 body 类标记“正在调整布局”，阅读器在此期间冻结页面宽度，
    // 防止中间内容随拖拽逐帧重排导致滚动跳动。
    document.body.classList.add("papermate-resizing");
    let currentLeft = startLeft;
    let currentRight = startRight;
    const applyWidths = (left: number, right: number) => {
      currentLeft = left;
      currentRight = right;
      const grid = gridRef.current;
      if (!grid) return;
      grid.style.gridTemplateColumns = `${Math.round(left)}px minmax(0, 1fr) ${Math.round(right)}px`;
      grid.style.setProperty("--left-panel-width", `${Math.round(left)}px`);
      grid.style.setProperty("--right-panel-width", `${Math.round(right)}px`);
    };
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (which === "left") {
        const maxLeft = Math.min(420, Math.max(170, window.innerWidth - startRight - 380 - 28));
        applyWidths(Math.min(maxLeft, Math.max(170, startLeft + delta)), startRight);
      } else {
        const maxRight = Math.min(620, Math.max(300, window.innerWidth - startLeft - 380 - 28));
        applyWidths(startLeft, Math.min(maxRight, Math.max(300, startRight - delta)));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("papermate-resizing");
      // 通知阅读器拖动结束，立即按最终宽度重新适配页面。
      window.dispatchEvent(new Event("papermate-resize-settled"));
      // 一次提交拖拽结果，布局持久化 effect 只触发一次。
      if (which === "left") {
        const maxLeft = Math.min(420, Math.max(170, window.innerWidth - currentRight - 380 - 28));
        setLeftWidth(Math.min(maxLeft, Math.max(170, currentLeft)));
      } else {
        const maxRight = Math.min(620, Math.max(300, window.innerWidth - currentLeft - 380 - 28));
        setRightWidth(Math.min(maxRight, Math.max(300, currentRight)));
      }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function handleFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("请导入 PDF 文件。本版本暂不支持 DOCX 与扫描件 OCR。");
      return;
    }
    setUploadState("loading");
    setNotice(undefined);
    await saveWorkspaceDebouncer.flush();
    try {
      const sourceHash = await blobSha256(file);
      const existing = await findPaperBySourceHash(sourceHash);
      if (existing) {
        setPapers((current) => {
          const others = current.filter((item) => item.id !== existing.id);
          return [paperToMeta(existing), ...others];
        });
        // 存量数据可能缺少文本项（中间版本导入），直接打开会导致划选高亮不可用，
        // 这里先补齐再打开。
        let opened = existing;
        if (!pagesHaveSelectableText(existing.pages)) {
          opened = await repairPaperOriginalMetadata(existing);
          if (opened.originalReady) {
            await savePaper(opened);
            setPapers((current) => {
              const others = current.filter((item) => item.id !== opened.id);
              return [paperToMeta(opened), ...others];
            });
          }
        }
        setPaper(opened);
        setNotice(`《${opened.title}》已经在本机论文库中，已直接打开。`);
        setUploadState("idle");
        return;
      }
      const parsed = await parsePdfFile(file);
      const { metadataTitle, ...parsedPaper } = parsed;
      const usableMetadataTitle = isWeakPaperTitle(metadataTitle)
        ? undefined
        : metadataTitle;
      const firstPageBlocks = firstPageMetadataBlocks(parsed.pages);
      const metadata = await lookupPaperMetadata({
        title: file.name.replace(/\.pdf$/i, ""),
        text: parsed.pages
          .slice(0, 3)
          .map((page) => page.text)
          .join("\n"),
        metadataTitle: usableMetadataTitle,
        blocks: firstPageBlocks.blocks,
        pageHeight: firstPageBlocks.pageHeight,
      }).catch(() => ({} as PaperMetadataPatch));
      const now = new Date().toISOString();
      const title =
        usableMetadataTitle?.trim() ||
        metadata.title?.trim() ||
        file.name.replace(/\.pdf$/i, "");
      const nextPaper: Paper = {
        id: uid(),
        title,
        fileName: file.name,
        file,
        sourceHash,
        keywords: metadata.keywords?.length ? metadata.keywords : undefined,
        journal: metadata.journal || undefined,
        impactFactor: metadata.impactFactor || undefined,
        createdAt: now,
        updatedAt: now,
        ...parsedPaper,
      };
      await savePaper(nextPaper);
      setPapers((current) => [paperToMeta(nextPaper), ...current]);
      setPaper(nextPaper);
      setNotice(`已在本机保存《${title}》，共 ${parsed.pageCount} 页。`);
      setUploadState("idle");
    } catch (error) {
      setUploadState("error");
      setNotice(error instanceof Error ? error.message : "无法读取该 PDF，请尝试其他文件。" );
    }
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void handleFile(event.dataTransfer.files?.[0]);
  }

  async function openPaper(item: PaperMeta) {
    await saveWorkspaceDebouncer.flush();
    const full = await getPaper(item.id);
    if (!full) {
      setPapers(await listPapers());
      setPaper(undefined);
      setNotice("这篇论文不存在或已被删除。");
      return;
    }
    const fileNameBase = full.fileName.replace(/\.pdf$/i, "");
    const titleIsFileName =
      full.title === fileNameBase || full.title === full.fileName;
    const titleNeedsLookup = titleIsFileName || isWeakPaperTitle(full.title);
    // 缺少影响因子时，每次打开都会在后台重试补齐（成功一次后即持久化，
    // 之后不再发起请求），OpenAlex 限流恢复后影响因子会自动出现。
    const needsMetaLookup =
      titleNeedsLookup || !full.impactFactor;
    // 旧版本数据没有 links 字段（所有页都缺失）或内部链接缺少目标坐标时需要重新解析补齐；
    // 若已有完整 links（即使某页恰好无链接）则不重复解析。
    const hasStaleLinks = full.pages.some((page) =>
      page.links?.some((link) => link.targetPage !== undefined && link.targetTop === undefined),
    );
    const needsLinkRepair =
      full.pages.length > 0 &&
      (full.pages.every((page) => page.links === undefined) || hasStaleLinks);
    // 存量数据可能缺失文本项（中间版本导入/旧版本），划选高亮依赖 textItems，
    // 缺失时同样需要重解析补齐。
    const needsTextRepair = !pagesHaveSelectableText(full.pages);
    const needsRepair = needsLinkRepair || needsTextRepair;
    const repairing = !full.originalReady || needsRepair;
    if (needsMetaLookup || repairing) {
      setBackfillingId(item.id);
      setNotice("正在补齐这篇论文的元数据和排版数据…");
    }
    try {
      // 排版数据（links/textItems）缺失时先同步修复，保证打开后划选、跳转可用；
      // 元数据补齐放后台，不阻塞阅读。
      let opened = full;
      if (repairing) {
        opened = await repairPaperOriginalMetadata(full);
        if (opened.originalReady) {
          setPapers((current) =>
            current.map((entry) =>
              entry.id === opened.id ? paperToMeta(opened) : entry,
            ),
          );
          await savePaper(opened);
        }
      }
      setPaper(opened);
      buddyEvent("paper-open", opened.title);
      if (!opened.originalReady) {
        setNotice("未读取到文本层，仍会显示原版页面。");
      } else if (repairing && !needsMetaLookup) {
        setNotice("已补齐这篇论文的排版数据。");
      }
      if (needsMetaLookup) {
        void enrichPaperMetadata(opened, titleNeedsLookup);
      } else {
        setBackfillingId(undefined);
      }
    } catch (error) {
      setBackfillingId(undefined);
      setNotice(error instanceof Error ? error.message : "补齐论文信息失败，请稍后重试。");
    }
  }

  async function enrichPaperMetadata(paper: Paper, titleNeedsLookup: boolean) {
    try {
      const firstPageBlocks = firstPageMetadataBlocks(paper.pages);
      const metadata = await lookupPaperMetadata({
        title: paper.title,
        text: paper.pages
          .slice(0, 3)
          .map((page) => page.text)
          .join("\n"),
        blocks: firstPageBlocks.blocks,
        pageHeight: firstPageBlocks.pageHeight,
      }).catch(() => ({} as PaperMetadataPatch));
      const nextTitle = titleNeedsLookup
        ? metadata.title?.trim() || paper.title
        : paper.title;
      const enriched: Paper = {
        ...paper,
        title: nextTitle,
        keywords: metadata.keywords?.length ? metadata.keywords : paper.keywords,
        journal: metadata.journal || paper.journal,
        impactFactor: metadata.impactFactor || paper.impactFactor,
      };
      const changed =
        nextTitle !== paper.title ||
        Boolean(
          metadata.keywords?.length ||
            metadata.journal ||
            metadata.impactFactor,
        );
      setPaper((current) => (current?.id === enriched.id ? enriched : current));
      if (changed) {
        setPapers((items) =>
          items.map((entry) =>
            entry.id === enriched.id ? paperToMeta(enriched) : entry,
          ),
        );
        await savePaper(enriched);
        setNotice("已补齐这篇论文的元数据。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "补齐论文信息失败，请稍后重试。");
    } finally {
      setBackfillingId(undefined);
    }
  }

  function selectAnchor(anchor: TextAnchor, additive: boolean) {
    if (!paper) return;
    const nextAnchors = additive
      ? [...activeAnchors.filter((item) => item.id !== anchor.id), anchor].slice(
          0,
          MAX_SELECTION_FRAGMENTS,
        )
      : [anchor];
    const nextSelection = selectionGroupForAnchors(paper.id, nextAnchors);
    setActiveAnchors(nextAnchors);
    const existing =
      workspace.conversations.find(
        (conversation) =>
          isNormalScope(conversation) &&
          conversationMatchesSelection(conversation, nextSelection, anchor),
      ) ??
      workspace.conversations.find((conversation) =>
        conversationMatchesSelection(conversation, nextSelection, anchor),
      );
    setActiveConversationId(existing?.id);
    setPendingColor(defaultHighlightColor(workspace.conversations.length));
    openView("chat");
    if (translateMode && !additive) {
      // 翻译模式已开启：完成一次新划选后立即翻译，并保持模式选中。
      void sendQuestion("translate", undefined, nextAnchors);
    }
    if (additive && nextAnchors.length === MAX_SELECTION_FRAGMENTS) {
      setNotice(`一次最多组合 ${MAX_SELECTION_FRAGMENTS} 个片段。`);
    }
  }

  function clearActiveSelection() {
    setActiveAnchors([]);
    setActiveConversationId(undefined);
  }

  function openView(view: RightView) {
    setRightView(view);
    setNoticeKinds((prev) => {
      const next = new Set(prev);
      next.delete(view);
      return next;
    });
  }

  function startKind(key: string, paperId: string) {
    taskPaperRef.current[key] = paperId;
    const next = new Set(runningKindsRef.current).add(key);
    runningKindsRef.current = next;
    setRunningKinds(next);
  }

  function finishKind(key: string, currentPaperId?: string) {
    const next = new Set(runningKindsRef.current);
    next.delete(key);
    runningKindsRef.current = next;
    setRunningKinds(next);
    if (rightViewRef.current !== key && taskPaperRef.current[key] === currentPaperId) {
      setNoticeKinds((prev) => new Set(prev).add(key));
    }
  }

  function selectConversation(conversation: Conversation) {
    setActiveConversationId(conversation.id);
    setActiveAnchors(
      conversation.selection?.anchors.length
        ? conversation.selection.anchors
        : conversation.anchor
          ? [conversation.anchor]
          : [],
    );
    setConversationFocusRequest((current) => ({
      conversationId: conversation.id,
      anchors: conversation.selection?.anchors.length
        ? conversation.selection.anchors
        : conversation.anchor
          ? [conversation.anchor]
          : [],
      nonce: (current?.nonce ?? 0) + 1,
    }));
    openView("chat");
  }

  function updateConversation(conversation: Conversation) {
    const base = workspaceRef.current;
    const exists = base.conversations.some((item) => item.id === conversation.id);
    if (!exists && deletedConversationIdsRef.current.has(conversation.id)) return;
    const next = {
      ...base,
      conversations: exists
        ? base.conversations.map((item) => (item.id === conversation.id ? conversation : item))
        : [conversation, ...base.conversations],
    };
    commitWorkspace(next);
  }

  function changeConversationColor(conversation: Conversation, color: HighlightColor) {
    updateConversation({ ...conversation, color, updatedAt: new Date().toISOString() });
  }

  function deleteConversation(target: Conversation) {
    if (runningChatIdsRef.current.has(target.id)) {
      setNotice("这条问答正在生成回复，请稍后再删除。");
      return;
    }
    const base = workspaceRef.current;
    const remaining = base.conversations.filter((item) => item.id !== target.id);
    if (remaining.length === base.conversations.length) return;
    deletedConversationIdsRef.current.add(target.id);
    if (activeConversationId === target.id || selectedConversation?.id === target.id) {
      setActiveConversationId(undefined);
      setActiveAnchors([]);
      setConversationFocusRequest(undefined);
    }
    commitWorkspace({ ...base, conversations: remaining });
    setNotice("已删除这条问答记录，对应对话内容和高亮已同步移除。");
  }

  // 只删除提问/问答索引里的这一条记录：用户问题与其后紧邻的回答成对移除，
  // 会话中的其他问答不受影响；会话因此清空时整体删除。
  function deleteConversationTurn(target: Conversation, turnId: string) {
    if (runningChatIdsRef.current.has(target.id)) {
      setNotice("这条问答正在生成回复，请稍后再删除。");
      return;
    }
    const turns = target.turns;
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    const removeCount =
      turns[index].role === "user" && turns[index + 1]?.role === "assistant" ? 2 : 1;
    const nextTurns = turns.filter((_, i) => i < index || i >= index + removeCount);
    if (!nextTurns.length) {
      deleteConversation(target);
      return;
    }
    updateConversation({
      ...target,
      turns: nextTurns,
      updatedAt: new Date().toISOString(),
    });
    setNotice("已删除这条问答记录。");
  }

  const apiKeyFor = (provider: ModelProvider) =>
    provider === "glm" ? glmApiKey : provider === "kimi" ? kimiApiKey : apiKey;
  const providerLabelFor = (provider: ModelProvider) =>
    provider === "glm" ? "智谱 GLM" : provider === "kimi" ? "Moonshot Kimi" : "DeepSeek";
  // 当前选中模型的 Key 与显示名（自定义模型的 Key 来自其配置）。
  const currentModelApiKey = (): string => {
    if (modelProvider === "custom") {
      return customModels.find((model) => model.id === modelId)?.apiKey?.trim() ?? "";
    }
    return apiKeyFor(modelProvider);
  };
  const currentModelLabel = (): string =>
    modelProvider === "custom"
      ? allModels.find((item) => item.id === modelId)?.label ?? "该自定义模型"
      : providerLabelFor(modelProvider);
  const activeModelLabel = allModels.find((item) => item.id === modelId)?.label ?? "模型";

  async function streamResponse(
    task: PromptKind | ArtifactKind,
    taskQuestion: string,
    context: string,
    history: Array<{ role: "user" | "assistant"; content: string }> = [],
    onText: (content: string) => void,
  ) {
    const run = async () => {
      // API Key 由服务端直接从 data/apikey.txt 读取，客户端不再随请求发送密钥。
      const response = await fetchWithRetry("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: modelProvider,
          modelId,
          mode,
          task,
          context,
          question: taskQuestion,
          messages: history.slice(-10).map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "无法获得模型回复。" );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let content = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
        onText(content);
      }
      return content;
    };
    // GLM 的单任务限制由调用方在 startKind 前统一拦截；这里所有 provider 都直接运行。
    return run();
  }

  async function sendQuestion(kind: PromptKind, forcedQuestion?: string, overrideAnchors?: TextAnchor[]) {
    if (!paper) return;
    const activeApiKey = currentModelApiKey();
    const providerLabel = currentModelLabel();
    if (!activeApiKey.trim()) {
      setSettingsOpen(true);
      setNotice(
        modelProvider === "custom"
          ? `请先在设置中为「${providerLabel}」配置 API Key。`
          : `请先在设置中填写并验证你的 ${providerLabel} API Key。`,
      );
      return;
    }
    const requestedQuestion = forcedQuestion?.trim() || question.trim();
    if (kind === "context" && !requestedQuestion) {
      setNotice("请先在输入框里输入问题，再发送。");
      return;
    }
    const finalQuestion = requestedQuestion || (kind === "free" ? "请解释这段内容。" : promptLabels[kind]);
    // 本次提问使用的选区：自动翻译等场景传入刚划选完成的锚点，其余沿用当前选区。
    const selectionAnchors = overrideAnchors ?? activeAnchors;
    const selectionGroup = selectionGroupForAnchors(paper.id, selectionAnchors);
    const selectionAnchor = selectionAnchors[0];
    if (!selectionAnchors.length && kind !== "free") {
      setNotice("先在原版页面上划选一段原文。" );
      return;
    }
    // 提问前先把最新 API Key 写回文件（服务端从 data/apikey.txt 读取）。
    await persistApiKeys();
    const now = new Date().toISOString();
    const isContextRequest = kind === "context";
    const baseConversations = workspaceRef.current.conversations;
    // 同一段原文 + 相同的提问内容 → 复用已有会话（覆盖旧记录，避免重复）。
    // 匹配顺序：选区/锚点身份 → 内容+问题 → 当前活动会话。
    const currentQuote = selectionAnchors[0] ? normalizedQuote(selectionAnchors[0].quote) : "";
    const fallbackByContent = !currentQuote
      ? undefined
      : baseConversations.find((candidate) => {
          const hasSameQuestion = candidate.turns.some(
            (turn) =>
              turn.role === "user" &&
              turn.kind === kind &&
              turn.content === finalQuestion &&
              turnQuote(turn) === currentQuote,
          );
          return hasSameQuestion;
        });
    const activeById = baseConversations.find((conversation) => conversation.id === activeConversationId);
    const baseConversation =
      (isContextRequest
        ? baseConversations.find(
            (conversation) =>
              conversation.scope === "context" &&
              conversationMatchesSelection(conversation, selectionGroup, selectionAnchor),
          )
        : baseConversations.find(
            (conversation) =>
              isNormalScope(conversation) &&
              conversationMatchesSelection(conversation, selectionGroup, selectionAnchor),
          )) ??
      fallbackByContent ??
      (isContextRequest
        ? undefined
        : activeById && isNormalScope(activeById)
          ? activeById
          : undefined);
    const conversation = baseConversation ?? {
      id: uid(),
      paperId: paper.id,
      anchor: selectionAnchor,
      selection: selectionGroup,
      scope: isContextRequest ? "context" : "normal",
      color: pendingColor ?? defaultHighlightColor(baseConversations.length),
      title: isContextRequest
        ? selectionGroup
          ? selectionGroup.anchors.length > 1
            ? `全文上下文 · ${selectionGroup.anchors.length} 个片段`
            : `全文上下文 · ${selectionGroup.anchors[0].section ?? `第 ${selectionGroup.anchors[0].page} 页`}`
          : "全文上下文"
        : selectionGroup
          ? selectionGroup.anchors.length > 1
            ? `${selectionGroup.anchors.length} 个片段问答`
            : `${selectionGroup.anchors[0].section ?? `第 ${selectionGroup.anchors[0].page} 页`}选段`
          : "全文问答",
      turns: [],
      updatedAt: now,
    };
    // 并发对话：同一个会话正在生成时不允许再次提问；其他会话不受影响。
    if (runningChatIdsRef.current.has(conversation.id)) {
      setNotice("该对话正在生成回复，请稍候。");
      return;
    }
    const userTurn: ChatTurn = {
      id: uid(),
      role: "user",
      content: finalQuestion,
      createdAt: now,
      mode,
      provider: modelProvider,
      kind,
      anchor: selectionAnchor,
      selection: selectionGroup,
    };
    const assistantTurn: ChatTurn = {
      id: uid(),
      role: "assistant",
      content: "",
      createdAt: now,
      mode,
      provider: modelProvider,
      kind,
      anchor: selectionAnchor,
      selection: selectionGroup,
    };
    // 同内容快捷提问去重：会话中已存在"相同提问 + 相同原文"的记录时，
    // 在原来的位置覆盖旧记录（用户问题与其后回答成对替换），不追加重复。
    const existingTurnIndex = conversation.turns.findIndex(
      (turn) =>
        turn.role === "user" &&
        turn.kind === kind &&
        turn.content === finalQuestion &&
        turnQuote(turn) === currentQuote,
    );
    const nextTurns =
      existingTurnIndex >= 0
        ? [
            ...conversation.turns.slice(0, existingTurnIndex),
            userTurn,
            assistantTurn,
            ...conversation.turns.slice(
              existingTurnIndex + (conversation.turns[existingTurnIndex + 1]?.role === "assistant" ? 2 : 1),
            ),
          ]
        : [...conversation.turns, userTurn, assistantTurn];
    let currentConversation = {
      ...conversation,
      anchor: selectionAnchor,
      selection: selectionGroup,
      turns: nextTurns,
      updatedAt: now,
    };
    // 通知陪读小人：按提问类型回应场景
    beginChat(currentConversation.id);
    updateConversation(currentConversation);
    setActiveConversationId(currentConversation.id);
    setPendingColor(defaultHighlightColor(baseConversations.length + 1));
    setQuestion("");
    beginChat(currentConversation.id);
    const selectedContext = buildContext(paper.pages, selectionAnchors);
    let historyMessages: Array<{ role: "user" | "assistant"; content: string }>;
    let requestContext: string;
    if (kind === "context") {
      const hasContextTurn = conversation.turns.some(
        (turn) => turn.role === "user" && turn.kind === "context",
      );
      if (hasContextTurn) {
        historyMessages = buildContextHistoryMessages(conversation.turns, paperDigest);
        requestContext = `[用户选中内容与相邻上下文]\n${selectedContext}`;
      } else {
        historyMessages = conversation.turns.map((turn) => ({ role: turn.role, content: turn.content }));
        const digestPart = paperDigest.trim()
          ? `[论文全文摘要与结构]\n${paperDigest}`
          : "";
        requestContext = [digestPart, `[用户选中内容与相邻上下文]\n${selectedContext}`]
          .filter(Boolean)
          .join("\n\n");
      }
    } else {
      historyMessages = conversation.turns.map((turn) => ({ role: turn.role, content: turn.content }));
      requestContext = selectedContext;
    }
    try {
      await streamResponse(kind, finalQuestion, requestContext, historyMessages, (content) => {
        currentConversation = {
          ...currentConversation,
          turns: currentConversation.turns.map((turn) => (turn.id === assistantTurn.id ? { ...turn, content } : turn)),
          updatedAt: new Date().toISOString(),
        };
        updateConversation(currentConversation);
      });
      // 回答完成后通知陪读小人：带上本次对话内容（原文选段 + 提问 + 回答），
      // 让小人结合对话内容聊天（翻译/问答场景）。
      const assistantReply =
        currentConversation.turns.find((turn) => turn.id === assistantTurn.id)?.content ?? "";
      const quoteText = selectionAnchors[0]?.quote?.trim()
        ? `原文选段：${selectionAnchors[0].quote.trim().slice(0, 200)}\n`
        : "";
      buddyEvent(
        kind === "translate" ? "translate" : kind === "context" || kind === "concept" ? "explain" : "ask",
        paper.title,
        `${quoteText}用户提问：${finalQuestion}\n模型回答：${assistantReply.slice(0, 500)}`,
      );
    } catch (error) {
      // 发送失败：不把失败内容写入对话——复用会话时恢复发送前的状态（含被覆盖的旧问答），
      // 新建的空会话整体移除；问题写回输入框，并弹出可复制的警示信息。
      const reason = error instanceof Error ? error.message : "未知错误";
      const latest = workspaceRef.current;
      const stillExists = latest.conversations.some((item) => item.id === conversation.id);
      if (stillExists && baseConversation) {
        updateConversation(baseConversation);
      } else if (stillExists) {
        commitWorkspace({
          ...latest,
          conversations: latest.conversations.filter((item) => item.id !== conversation.id),
        });
        if (activeConversationId === conversation.id) setActiveConversationId(undefined);
      }
      // 输入框未被用户改写过时，把失败内容写回聊天框。
      setQuestion((currentValue) => (currentValue.trim() ? currentValue : requestedQuestion));
      setErrorDialog({
        title: "消息发送失败",
        message: `${reason}`,
      });
    } finally {
      endChat(currentConversation.id);
    }
  }

  async function generateArtifact(kind: ArtifactKind) {
    if (!paper) return;
    if (runningKinds.has(kind)) return;
    const activeApiKey = currentModelApiKey();
    const providerLabel = currentModelLabel();
    if (!activeApiKey.trim()) {
      setSettingsOpen(true);
      setNotice(
        modelProvider === "custom"
          ? `请先在设置中为「${providerLabel}」配置 API Key。`
          : `请先在设置中填写并验证你的 ${providerLabel} API Key。`,
      );
      return;
    }
    // 生成前先把最新 API Key 写回文件（服务端从 data/apikey.txt 读取）。
    await persistApiKeys();
    startKind(kind, paper.id);
    // 陪读小人：成果生成只给论文题目 + 摘要，让它据此聊天。
    const buddyAbstract = (paperDigest?.trim() ? paperDigest.trim() : paper.pages[0]?.text?.slice(0, 300) ?? "")
      .slice(0, 500);
    const buddyPayload = buddyAbstract ? `论文摘要：\n${buddyAbstract}` : undefined;
    buddyEvent(`generate:${kind}`, paper.title, buddyPayload);
    const details = artifactDetails[kind];
    const base = workspaceRef.current;
    // 保留已有成果：重新生成时沿用原记录（同 id），流式更新内容；
    // 若生成失败则恢复原内容，绝不覆盖原本数据，只提示失败原因。
    const existing = base.artifacts.find((item) => item.kind === kind);
    const previousContent = existing?.content ?? "";
    const previousVersions = existing?.versions ?? [];
    let artifact: GeneratedArtifact = existing ?? {
      id: uid(),
      paperId: paper.id,
      kind,
      title: details.title,
      content: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const start = { ...base, artifacts: [artifact, ...base.artifacts.filter((item) => item.kind !== kind)] };
    commitWorkspace(start);
    try {
      await streamResponse(kind, `请分析《${paper.title}》。`, documentContext(paper), [], (content) => {
        artifact = { ...artifact, content, updatedAt: new Date().toISOString() };
        const current = workspaceRef.current;
        commitWorkspace({ ...current, artifacts: [artifact, ...current.artifacts.filter((item) => item.kind !== kind)] });
      });
      // 生成成功：把生成前的内容自动保存为历史版本（内容与最新版本相同则跳过，避免重复）。
      if (existing && previousContent.trim()) {
        const newest = previousVersions[0];
        const nextVersions: ArtifactVersion[] =
          newest && newest.content === previousContent
            ? previousVersions
            : [
                { id: uid(), content: previousContent, createdAt: existing.updatedAt },
                ...previousVersions,
              ].slice(0, MAX_ARTIFACT_VERSIONS);
        const withVersions = { ...artifact, versions: nextVersions };
        artifact = withVersions;
        const current = workspaceRef.current;
        commitWorkspace({ ...current, artifacts: [withVersions, ...current.artifacts.filter((item) => item.kind !== kind)] });
      }
      buddyEvent(`done:${kind}`, paper.title, buddyPayload);
    } catch (error) {
      // 生成失败：恢复原有内容（或移除本次新建的空草稿），弹警示信息说明原因。
      const reason = error instanceof Error ? error.message : "未知错误";
      const current = workspaceRef.current;
      if (existing) {
        const restored: GeneratedArtifact = {
          ...artifact,
          content: previousContent,
          updatedAt: existing.updatedAt,
        };
        commitWorkspace({
          ...current,
          artifacts: current.artifacts.map((item) => (item.id === artifact.id ? restored : item)),
        });
      } else {
        commitWorkspace({
          ...current,
          artifacts: current.artifacts.filter((item) => item.id !== artifact.id),
        });
      }
      setErrorDialog({ title: `${details.title}生成失败`, message: reason });
    } finally {
      finishKind(kind, paper?.id);
    }
  }

  function deleteArtifact(kind: ArtifactKind) {
    const base = workspaceRef.current;
    if (!base.artifacts.some((item) => item.kind === kind)) return;
    setDeleteConfirm({ type: "artifact", kind });
  }

  function confirmDeleteArtifact(kind: ArtifactKind) {
    const base = workspaceRef.current;
    commitWorkspace({ ...base, artifacts: base.artifacts.filter((item) => item.kind !== kind) });
    setNotice(`已删除「${artifactDetails[kind].title}」。`);
  }

  function saveArtifactVersion(kind: ArtifactKind) {
    const base = workspaceRef.current;
    const current = base.artifacts.find((item) => item.kind === kind);
    if (!current || !current.content.trim()) return;
    const versions = current.versions ?? [];
    const newest = versions[0];
    if (newest && newest.content === current.content) {
      setNotice("当前内容已是最近保存的版本，无需重复保存。");
      return;
    }
    const nextVersion: ArtifactVersion = {
      id: uid(),
      content: current.content,
      createdAt: new Date().toISOString(),
    };
    const next: GeneratedArtifact = {
      ...current,
      versions: [nextVersion, ...versions].slice(0, MAX_ARTIFACT_VERSIONS),
    };
    commitWorkspace({ ...base, artifacts: base.artifacts.map((item) => (item.id === next.id ? next : item)) });
    setNotice(`已保存「${artifactDetails[kind].title}」当前版本。`);
  }

  /** 删除某个历史版本（当前内容不受影响）。 */
  function deleteArtifactVersion(kind: ArtifactKind, versionId: string) {
    const base = workspaceRef.current;
    const artifact = base.artifacts.find((item) => item.kind === kind);
    if (!artifact || !artifact.versions?.length) return;
    setDeleteConfirm({ type: "version", kind, versionId });
  }

  function confirmDeleteArtifactVersion(kind: ArtifactKind, versionId: string) {
    const base = workspaceRef.current;
    const artifact = base.artifacts.find((item) => item.kind === kind);
    if (!artifact || !artifact.versions?.length) return;
    const versions = artifact.versions.filter((version) => version.id !== versionId);
    if (versions.length === artifact.versions.length) return;
    const next: GeneratedArtifact = {
      ...artifact,
      versions,
      updatedAt: new Date().toISOString(),
    };
    commitWorkspace({ ...base, artifacts: base.artifacts.map((item) => (item.id === next.id ? next : item)) });
    setNotice("已删除该历史版本。");
  }

  function editArtifact(kind: ArtifactKind, content: string) {
    const base = workspaceRef.current;
    const current = base.artifacts.find((item) => item.kind === kind);
    if (!current) return;
    const next = { ...current, content, updatedAt: new Date().toISOString() };
    commitWorkspace({ ...base, artifacts: base.artifacts.map((item) => (item.id === next.id ? next : item)) });
  }

  async function testKey(provider: ModelProvider) {
    const key = apiKeyFor(provider);
    if (!key.trim()) return;
    const setState =
      provider === "glm"
        ? setGlmKeyState
        : provider === "kimi"
          ? setKimiKeyState
          : setKeyState;
    setState("testing");
    try {
      const response = await fetch("/api/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: key }),
      });
      setState(response.ok ? "valid" : "invalid");
    } catch {
      setState("invalid");
    }
  }

  async function removePaper(id: string) {
    await saveWorkspaceDebouncer.flush();
    await deletePaper(id);
    setPapers((items) => items.filter((item) => item.id !== id));
    if (editingNotePaperId === id) setEditingNotePaperId(undefined);
    if (paper?.id === id) setPaper(undefined);
  }

  function beginNoteEdit(item: PaperMeta) {
    setEditingNotePaperId(item.id);
    setNoteDraft(item.note ?? "");
  }

  function closeNoteEditor() {
    setEditingNotePaperId(undefined);
    setNoteDraft("");
  }

  async function saveNote(item: PaperMeta) {
    const note = noteDraft.trim();
    setPapers((items) =>
      items.map((entry) => (entry.id === item.id ? { ...entry, note } : entry)),
    );
    if (paper?.id === item.id) setPaper((current) => (current ? { ...current, note } : current));
    await updatePaperNote(item.id, note);
    closeNoteEditor();
  }

  // ---- 论文库排序：拖拽 + 置顶 ----

  async function refreshLibraryOrder() {
    try {
      const fresh = await listPapers();
      setPapers(fresh);
    } catch {
      // 刷新失败时保留当前顺序
    }
  }

  async function togglePin(item: PaperMeta) {
    const nextPinned = !item.pinned;
    const updated = { ...item, pinned: nextPinned };
    setPapers((current) => {
      const others = current.filter((entry) => entry.id !== item.id);
      if (nextPinned) {
        // 置顶：放到置顶组最前（服务端会把其余置顶论文顺延）。
        return [updated, ...others.filter((entry) => entry.pinned), ...others.filter((entry) => !entry.pinned)];
      }
      // 取消置顶：放到未置顶组最后。
      return [...others.filter((entry) => entry.pinned), ...others.filter((entry) => !entry.pinned), updated];
    });
    try {
      await setPaperPinned(item.id, nextPinned);
      await refreshLibraryOrder();
    } catch {
      setNotice("置顶操作保存失败。");
      await refreshLibraryOrder();
    }
  }

  function reorderLibrary(fromId: string, toId: string) {
    if (fromId === toId) return;
    const fromIndex = papers.findIndex((entry) => entry.id === fromId);
    const toIndex = papers.findIndex((entry) => entry.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...papers];
    const [moved] = next.splice(fromIndex, 1);
    const targetIndex = next.findIndex((entry) => entry.id === toId);
    if (targetIndex < 0) return;
    // 保持置顶组在前：置顶论文只能落在置顶组内，未置顶论文只能落在未置顶组内。
    const pinnedCount = next.filter((entry) => entry.pinned).length + (moved.pinned ? 1 : 0);
    const clampedIndex = moved.pinned
      ? Math.min(targetIndex, pinnedCount - 1)
      : Math.max(targetIndex, pinnedCount);
    next.splice(clampedIndex, 0, moved);
    setPapers(next);
    // 以新顺序持久化（服务端按数组序号写 sort_order）。
    void reorderPapers(next.map((entry) => entry.id)).catch(() => {
      setNotice("排序保存失败，已恢复原顺序。");
      void refreshLibraryOrder();
    });
  }

  if (!paper) {
    return (
      <main className="landing-shell">
        <header className="landing-header">
          <Brand />
          <div className="header-actions">
            <ThemeSwitcher theme={theme} onChange={setTheme} />
            <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> 设置</button>
          </div>
        </header>
        <section className="hero">
          <span className="eyebrow"><Sparkles size={14} /> LOCAL-FIRST PAPER COMPANION</span>
          <h1>把每一段读不懂的论文，<br />变成自己的理解。</h1>
          <p>拖入可检索 PDF，划选原文即可翻译、追问与深度解释；脑图、笔记和写作策略始终保留在你的本机。</p>
          <div
            className={`drop-zone ${uploadState === "loading" ? "is-loading" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => event.key === "Enter" && fileInputRef.current?.click()}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadState === "loading" ? <LoaderCircle className="spin" size={25} /> : <FilePlus2 size={27} />}
            <strong>{uploadState === "loading" ? "正在解析你的论文…" : "拖入论文 PDF"}</strong>
            <span>或点击选择文件 · 仅支持有文本层的 PDF</span>
          </div>
          <input ref={fileInputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={onInputChange} />
          {notice && <p className={`notice ${uploadState === "error" ? "error" : ""}`}>{notice}</p>}
        </section>
        <section className="library-section">
          <div className="section-label">
            <FolderOpen size={17} /> 本地论文库 <span>{visiblePapers.length}</span>
            <small className="library-order-hint">拖动卡片排序 · 图钉置顶</small>
          </div>
          <div className="library-search">
            <Search size={15} />
            <input
              type="search"
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              placeholder="搜索论文标题、文件名或备注"
              aria-label="搜索本地论文库"
            />
            {libraryQuery ? (
              <button className="library-search-clear" onClick={() => setLibraryQuery("")} aria-label="清空搜索"><X size={13} /></button>
            ) : null}
          </div>
          <p className={`library-backup-status ${backupState === "error" ? "error" : ""}`}>
            <HardDrive size={12} />
            {backupState === "saving"
              ? "正在生成完整 JSON…"
              : backupState === "restoring"
                ? "正在从备份恢复…"
                : backupState === "error"
                  ? "完整 JSON 备份失败，请检查磁盘"
                  : backupSavedAt
                    ? `完整 JSON 已手动备份 · ${readableDateTime(backupSavedAt)}`
                    : "数据库自动保存 · 完整 JSON 手动备份"}
          </p>
          {visiblePapers.length ? (
            <div className="library-grid">
              {visiblePapers.map((item) => (
                <article
                  className={`paper-card${backfillingId === item.id ? " is-backfilling" : ""}${dragPaperId === item.id ? " is-dragging" : ""}${dragOverId === item.id ? " is-drag-over" : ""}`}
                  key={item.id}
                  draggable={!libraryQuery.trim() && papers.length > 1}
                  onDragStart={(event) => {
                    if (libraryQuery.trim() || papers.length <= 1) return;
                    setDragPaperId(item.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragPaperId || dragPaperId === item.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dragOverId !== item.id) setDragOverId(item.id);
                  }}
                  onDragLeave={(event) => {
                    if (dragOverId === item.id && !event.currentTarget.contains(event.relatedTarget as Node)) {
                      setDragOverId(undefined);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragPaperId && dragPaperId !== item.id) {
                      reorderLibrary(dragPaperId, item.id);
                    }
                    setDragPaperId(undefined);
                    setDragOverId(undefined);
                  }}
                  onDragEnd={() => {
                    setDragPaperId(undefined);
                    setDragOverId(undefined);
                  }}
                >
                  <button className="paper-card-open" onClick={() => void openPaper(item)}>
                    <span className="paper-icon"><FileText size={22} /></span>
                    <strong>{item.title}</strong>
                    <small>{item.pageCount} 页 · {readableDate(item.updatedAt)} 保存</small>
                    <ChevronRight size={17} />
                  </button>
                  {backfillingId === item.id ? (
                    <div className="paper-card-backfill" role="status">
                      <LoaderCircle className="spin" size={14} />
                      <span>正在补齐论文信息…</span>
                    </div>
                  ) : null}
                  {item.journal || item.impactFactor || item.keywords?.length ? (
                    <div className="paper-card-metadata">
                      {item.journal || item.impactFactor ? (
                        <div className="paper-card-facts">
                          {item.journal ? <span>{item.journal}</span> : null}
                          {item.impactFactor ? <span>影响因子 {item.impactFactor}</span> : null}
                        </div>
                      ) : null}
                      {item.keywords?.length ? (
                        <div className="paper-card-keywords" aria-label="关键词">
                          {item.keywords.map((keyword, index) => (
                            <span key={`${keyword}-${index}`}>{keyword}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {editingNotePaperId === item.id ? (
                    <div className="paper-note-editor">
                      <textarea
                        value={noteDraft}
                        onChange={(event) => setNoteDraft(event.target.value)}
                        placeholder="给这篇论文写点备注"
                        aria-label={`备注 ${item.title}`}
                      />
                      <div className="paper-note-actions">
                        <button className="paper-note-save" onClick={() => void saveNote(item)}><Check size={13} /> 保存</button>
                        <button className="paper-note-cancel" onClick={closeNoteEditor}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <button className={`paper-note-trigger ${item.note ? "has-note" : ""}`} onClick={() => beginNoteEdit(item)}>
                      <StickyNote size={13} />
                      <span>{item.note || "添加备注"}</span>
                    </button>
                  )}
                  <button
                    className={`paper-pin${item.pinned ? " active" : ""}`}
                    aria-label={item.pinned ? `取消置顶 ${item.title}` : `置顶 ${item.title}`}
                    title={item.pinned ? "取消置顶（已置顶）" : "置顶"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void togglePin(item);
                    }}
                  >
                    <Pin size={14} />
                  </button>
                  <button className="paper-remove" aria-label={`删除 ${item.title}`} onClick={() => void removePaper(item.id)}><Trash2 size={15} /></button>
                </article>
              ))}
            </div>
          ) : papers.length ? (
            <p className="empty-library">没有匹配的论文，换个关键词试试。</p>
          ) : (
            <p className="empty-library">还没有论文。首次导入后，文件和成果自动保存到本机数据库。</p>
          )}
        </section>
        <SettingsSheet
          open={settingsOpen}
          onClose={closeSettings}
          apiKey={apiKey}
          setApiKey={setApiKey}
          state={keyState}
          onTest={() => void testKey("deepseek")}
          glmApiKey={glmApiKey}
          setGlmApiKey={setGlmApiKey}
          glmState={glmKeyState}
          onTestGlm={() => void testKey("glm")}
          kimiApiKey={kimiApiKey}
          setKimiApiKey={setKimiApiKey}
          kimiState={kimiKeyState}
          onTestKimi={() => void testKey("kimi")}
          theme={theme}
          onThemeChange={setTheme}
          backupState={backupState}
          backupSavedAt={backupSavedAt}
          backupFilePath={backupFilePath}
          onBackupNow={() => void writeBackupNow()}
          onRestoreBackup={() => void restoreFromBackup()}
          onExportBackup={() => void exportBackupFile()}
          onImportBackup={(file) => void importBackupFile(file)}
          onCopyPath={(ok) => setNotice(ok ? "备份文件路径已复制到剪贴板。" : "无法复制路径，请手动复制上方文件位置。")}
          customModels={customModels}
          onSaveCustomModel={handleSaveCustomModel}
          onDeleteCustomModel={handleDeleteCustomModel}
          onTestCustomModel={handleTestCustomModel}
        />
      </main>
    );
  }

  const artifact = rightView === "chat" ? undefined : workspace.artifacts.find((item) => item.kind === rightView);
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <button className="brand-small" onClick={() => { setPaper(undefined); buddyEvent("paper-close"); }} aria-label="返回论文库"><PanelLeftClose size={17} /><span>返 回 论 文 库</span></button>
        <div className="paper-title"><FileText size={16} /><strong>{paper.title}</strong><span>{paper.pageCount} 页 · 本地保存</span></div>
        <div className="header-actions">
          {notice && <span className="compact-notice">{notice}</span>}
          <button
            className={`buddy-toggle ${buddyVisible ? "active" : ""}`}
            onClick={toggleBuddyVisible}
            title={buddyVisible ? "隐藏陪读小人" : "显示陪读小人"}
            aria-label="显示或隐藏陪读小人"
            aria-pressed={buddyVisible}
          ><Bot size={16} /></button>
          <ThemeSwitcher theme={theme} onChange={setTheme} />
          <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> 设置</button>
        </div>
      </header>
      <div
        ref={gridRef}
        className="workspace-grid"
        style={isMobile ? undefined : ({
          gridTemplateColumns: `${leftCollapsed ? 0 : leftWidth}px minmax(0, 1fr) ${rightCollapsed ? 0 : rightWidth}px`,
          "--left-panel-width": `${leftCollapsed ? 0 : leftWidth}px`,
          "--right-panel-width": `${rightCollapsed ? 0 : rightWidth}px`,
        } as CSSProperties)}
      >
        <aside className={`left-sidebar ${leftCollapsed ? "collapsed" : ""}`}>
          <div className="left-sidebar-header">
            <Brand compact />
            <button className="panel-collapse" onClick={() => setLeftCollapsed(true)} aria-label="折叠左侧" title="折叠左侧"><PanelLeftClose size={15} /></button>
          </div>
          <nav className="workspace-nav" aria-label="论文功能">
            <button className={rightView === "chat" ? "active" : ""} onClick={() => openView("chat")}><MessageCircleMore size={17} /> 选段问答{runningKinds.has("chat") ? <LoaderCircle className="spin nav-side-icon" size={13} /> : noticeKinds.has("chat") ? <span className="nav-badge" aria-label="有新的问答结果" /> : null}</button>
            {(Object.keys(artifactDetails) as ArtifactKind[]).map((kind) => {
              const Icon = artifactDetails[kind].icon;
              return <button key={kind} className={rightView === kind ? "active" : ""} onClick={() => openView(kind)}><Icon size={17} /> {artifactDetails[kind].title}{runningKinds.has(kind) ? <LoaderCircle className="spin nav-side-icon" size={13} /> : noticeKinds.has(kind) ? <span className="nav-badge" aria-label="有新的生成结果" /> : null}</button>;
            })}
          </nav>
          <div className="sidebar-model">
            <ModelSwitch models={allModels} modelId={modelId} onChange={changeModelId} mode={mode} onModeChange={changeMode} />
          </div>
          <div className="sidebar-divider" />
          <details className="chapter-index" open>
            <summary><BookOpen size={14} /> 章节目录 <b>{(paper.outline ?? []).length}</b></summary>
            <div className="chapter-index-list">
              {(paper.outline ?? []).length ? paper.outline!.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={[
                    activeChapter.page === section.page ? "active" : "",
                    activeChapter.sectionId === section.id ? "current" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ "--chapter-level": Math.min(5, Math.max(0, section.level - 1)) } as CSSProperties}
                  title={section.title}
                  onClick={() => {
                    setActiveChapter({ sectionId: section.id, page: section.page });
                    setChapterScrollRequest((current) => ({
                      page: section.page,
                      sectionId: section.id,
                      nonce: (current?.nonce ?? 0) + 1,
                    }));
                  }}
                >
                  <span className="chapter-title">{section.title}</span>
                  <span className="chapter-page">p.{section.page}</span>
                </button>
              )) : <p className="sidebar-empty">未识别到章节标题。</p>}
            </div>
          </details>
          <SidebarQuote />
        </aside>
        <PdfReader
          paper={paper}
          activeAnchors={activeAnchors}
          highlightRegions={highlightRegions}
          conversations={workspace.conversations}
          activeConversationId={activeConversationId}
          onDeleteTurn={deleteConversationTurn}
          outline={paper.outline ?? []}
          requestedChapterPage={chapterScrollRequest}
          conversationFocusRequest={conversationFocusRequest}
          pendingColor={pendingColor}
          onSelectAnchor={selectAnchor}
          onClearSelection={clearActiveSelection}
          onActiveChapterChange={onActiveChapterChange}
          leftCollapsed={leftCollapsed}
          rightCollapsed={rightCollapsed}
          onRestoreLeft={() => setLeftCollapsed(false)}
          onRestoreRight={() => setRightCollapsed(false)}
        />
        <aside className={`assistant-panel ${rightCollapsed ? "collapsed" : ""}`}>
          <button
            className="panel-collapse panel-collapse-corner"
            onClick={() => setRightCollapsed(true)}
            aria-label="折叠右侧"
            title="折叠右侧"
          ><PanelRightClose size={15} /></button>
          {rightView === "chat" ? (
            <ChatPanel
              anchors={activeAnchors}
              selectionGroup={activeSelection}
              conversation={selectedConversation}
              conversations={workspace.conversations}
              activeConversationId={activeConversationId}
              question={question}
              setQuestion={setQuestion}
              // 并发对话：仅当当前会话正在生成时禁用发送；其他会话可同时提问（GLM 免费档亦支持并发）。
              generating={Boolean(selectedConversation?.id && runningChatIds.has(selectedConversation.id))}
              pendingColor={pendingColor}
              onPendingColorChange={setPendingColor}
              onChangeColor={changeConversationColor}
              contextMode={contextMode}
              onToggleContext={() => setContextMode((current) => !current)}
              translateMode={translateMode}
              onTranslateModeChange={setTranslateMode}
              onPrompt={(kind) => void sendQuestion(kind)}
              onSelectConversation={selectConversation}
              onDeleteTurn={deleteConversationTurn}
              provider={modelProvider}
              mode={mode}
              modelLabel={activeModelLabel}
            />
          ) : (
            <ArtifactPanel
              kind={rightView}
              paper={paper}
              artifact={artifact}
              generating={runningKinds.has(rightView)}
              onGenerate={() => void generateArtifact(rightView)}
              onEdit={(content) => editArtifact(rightView, content)}
              onDelete={() => deleteArtifact(rightView)}
              onSaveVersion={() => saveArtifactVersion(rightView)}
              onDeleteVersion={(versionId) => deleteArtifactVersion(rightView, versionId)}
            />
          )}
        </aside>
        {!isMobile && (
          <div className="resize-handle left" onPointerDown={(event) => startResize("left", event)} role="separator" aria-orientation="vertical" aria-label="调整左侧宽度" />
        )}
        {!isMobile && (
          <div className="resize-handle right" onPointerDown={(event) => startResize("right", event)} role="separator" aria-orientation="vertical" aria-label="调整右侧宽度" />
        )}
      </div>
      {buddyVisible && <BuddySystem noteCount={workspace.conversations.length} />}
      <SettingsSheet
        open={settingsOpen}
        onClose={closeSettings}
        apiKey={apiKey}
        setApiKey={setApiKey}
        state={keyState}
        onTest={() => void testKey("deepseek")}
        glmApiKey={glmApiKey}
        setGlmApiKey={setGlmApiKey}
        glmState={glmKeyState}
        onTestGlm={() => void testKey("glm")}
        kimiApiKey={kimiApiKey}
        setKimiApiKey={setKimiApiKey}
        kimiState={kimiKeyState}
        onTestKimi={() => void testKey("kimi")}
        theme={theme}
        onThemeChange={setTheme}
        backupState={backupState}
        backupSavedAt={backupSavedAt}
        backupFilePath={backupFilePath}
        onBackupNow={() => void writeBackupNow()}
        onRestoreBackup={() => void restoreFromBackup()}
        onExportBackup={() => void exportBackupFile()}
        onImportBackup={(file) => void importBackupFile(file)}
        onCopyPath={(ok) => setNotice(ok ? "备份文件路径已复制到剪贴板。" : "无法复制路径，请手动复制上方文件位置。")}
        customModels={customModels}
        onSaveCustomModel={handleSaveCustomModel}
        onDeleteCustomModel={handleDeleteCustomModel}
        onTestCustomModel={handleTestCustomModel}
      />
      {errorDialog ? (
        <div className="error-dialog" role="alertdialog" aria-label={errorDialog.title}>
          <div className="error-dialog-head">
            <span className="error-dialog-icon"><CircleAlert size={16} /></span>
            <strong>{errorDialog.title}</strong>
            <button type="button" className="error-dialog-close" aria-label="关闭" title="关闭" onClick={() => setErrorDialog(null)}><X size={15} /></button>
          </div>
          <p className="error-dialog-body">{errorDialog.message}</p>
          <div className="error-dialog-actions">
            <button
              type="button"
              onClick={() => {
                void copyTextToClipboard(errorDialog.message).catch(() =>
                  setNotice("复制失败，请手动选择错误信息文本。"),
                );
              }}
            >
              <Copy size={14} /> 复制错误信息
            </button>
            <button type="button" className="primary" onClick={() => setErrorDialog(null)}>关闭</button>
          </div>
        </div>
      ) : null}
      {deleteConfirm ? (
        <div className="confirm-overlay" role="alertdialog" aria-modal="true" aria-label="确认删除" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <span className="confirm-dialog-icon"><Trash2 size={18} /></span>
            <div className="confirm-dialog-text">
              <strong>
                {deleteConfirm.type === "artifact"
                  ? `删除「${artifactDetails[deleteConfirm.kind].title}」？`
                  : "删除这个历史版本？"}
              </strong>
              <p>删除后无法恢复。</p>
            </div>
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setDeleteConfirm(null)}>取消</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (deleteConfirm.type === "artifact") {
                    confirmDeleteArtifact(deleteConfirm.kind);
                  } else {
                    confirmDeleteArtifactVersion(deleteConfirm.kind, deleteConfirm.versionId);
                  }
                  setDeleteConfirm(null);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><span className="brand-mark"><BrainCircuit size={compact ? 18 : 21} /></span><span><strong>Paper<span>mate</span></strong>{!compact && <small>论文阅读辅助助手</small>}</span></div>;
}

function SidebarQuote() {
  const [quotes, setQuotes] = useState<readonly string[]>(READER_QUOTES);
  const [quoteIndex, setQuoteIndex] = useState(0);

  // 拾句内容来自项目 public/quotes.txt（纯文本，可直接增删改），
  // 加载一次后保存在缓存中，刷新页面后重新读取；失败时用内置列表。
  useEffect(() => {
    let cancelled = false;
    void loadReaderQuotes().then((loaded) => {
      if (!cancelled) setQuotes(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickNext = useCallback(() => {
    setQuoteIndex((current) => {
      if (quotes.length <= 1) return 0;
      let next = Math.floor(Math.random() * quotes.length);
      if (next === current) {
        next = (next + 1 + Math.floor(Math.random() * (quotes.length - 1))) % quotes.length;
      }
      return next;
    });
  }, [quotes.length]);

  useEffect(() => {
    pickNext();
    const timer = window.setInterval(pickNext, 45000);
    return () => window.clearInterval(timer);
  }, [pickNext]);

  const quote = quotes[quoteIndex] ?? "";
  return (
    <button type="button" className="sidebar-quote" aria-label="切换一句" title="点击切换一句" onClick={pickNext}>
      <span className="sidebar-quote-kicker"><Quote size={12} /> 拾句 <RefreshCw size={12} /></span>
      <span key={quoteIndex} className="sidebar-quote-text">{quote}</span>
    </button>
  );
}

function ThemeSwitcher({ theme, onChange }: { theme: ThemeId; onChange: (theme: ThemeId) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = THEMES.find((item) => item.id === theme) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="theme-switcher" ref={rootRef}>
      <button
        type="button"
        className="theme-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="切换阅读主题"
        onClick={() => setOpen((value) => !value)}
      >
        <Palette size={16} />
        <span className="theme-trigger-swatch" style={active.swatch} />
        <span className="theme-trigger-label">{active.name}</span>
        <ChevronDown size={14} className="theme-trigger-chevron" />
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="阅读主题">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === theme}
              className={`theme-menu-item ${item.id === theme ? "active" : ""}`}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
            >
              <span className="theme-trigger-swatch" style={item.swatch} />
              <span>
                <b>{item.name}</b>
                <small>{item.description}</small>
              </span>
              {item.id === theme && <Check size={14} className="theme-menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function modelIcon(provider: ModelProvider, size: number) {
  return provider === "glm" ? <Sparkles size={size} /> : provider === "kimi" ? <Moon size={size} /> : provider === "custom" ? <Bot size={size} /> : <Zap size={size} />;
}

function ModelSwitch({ models, modelId, onChange, mode, onModeChange }: {
  models: ClientModelOption[];
  modelId: string;
  onChange: (next: string) => void;
  mode: ModelMode;
  onModeChange: (mode: ModelMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 当前显示的模型（驱动翻转动画：先翻出旧内容，再翻入新内容）
  const [shown, setShown] = useState<ClientModelOption | undefined>(undefined);
  const shownRef = useRef<ClientModelOption | undefined>(undefined);
  shownRef.current = shown;
  const [flip, setFlip] = useState<"none" | "out" | "in">("none");
  const flipTimer = useRef<number | undefined>(undefined);
  const wheelAccum = useRef(0);
  const lastWheelAt = useRef(0);
  const pickRef = useRef<(next: ClientModelOption) => void>(() => {});
  pickRef.current = (next) => {
    if (!next) return;
    // 点击当前已选中的模型：不重复切换，但仍收起菜单。
    if (next.id !== shownRef.current?.id) {
      window.clearTimeout(flipTimer.current);
      setFlip("out");
      flipTimer.current = window.setTimeout(() => {
        setShown(next);
        setFlip("in");
        flipTimer.current = window.setTimeout(() => setFlip("none"), 180);
      }, 170);
      onChange(next.id);
    }
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(flipTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const active = models.find((item) => item.id === modelId) ?? models[0];
  // 外部变更（如删除模型回退、列表刷新）时同步显示；翻转期间不打断动画。
  useEffect(() => {
    if (flip !== "none") return;
    if (active && (!shown || active.id !== shown.id || active.label !== shown.label || active.badge !== shown.badge)) {
      setShown(active);
    }
  }, [active, flip, shown]);

  // 滚轮上下切换模型（原生非被动监听，阻止页面滚动；累计阈值 + 冷却防误触）
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (open) return;
      const now = Date.now();
      if (now - lastWheelAt.current < 200) return;
      wheelAccum.current += event.deltaY;
      if (Math.abs(wheelAccum.current) < 45) return;
      wheelAccum.current = 0;
      lastWheelAt.current = now;
      if (!models.length) return;
      const index = models.findIndex((item) => item.id === modelId);
      const base = index === -1 ? 0 : index;
      // 向下滚动 → 下一个模型；向上滚动 → 上一个模型（循环）。
      const dir = event.deltaY > 0 ? 1 : -1;
      const next = models[(base + dir + models.length) % models.length];
      if (next) pickRef.current(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [models, modelId, open]);

  return (
    <div className="model-switch-stack">
      <div className="model-switch" role="group" aria-label="回答模式">
        <button className={mode === "fast" ? "active" : ""} onClick={() => onModeChange("fast")}><span>快速</span><small>非思考</small></button>
        <button className={mode === "deep" ? "active" : ""} onClick={() => onModeChange("deep")}><span>深度</span><small>思考</small></button>
      </div>
      <div className="model-select" ref={rootRef}>
        <button
          ref={triggerRef}
          className="model-select-trigger"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="滚轮上下切换 · 点击选择模型"
        >
          <span className={`model-select-flip ${flip === "out" ? "is-out" : flip === "in" ? "is-in" : ""}`}>
            {shown ? modelIcon(shown.provider, 13) : null}
            <span className="model-select-label">{shown?.label ?? "模型"}</span>
            <span className="model-select-badge">{shown?.badge ?? ""}</span>
          </span>
          <ChevronDown size={13} className={`model-select-chevron ${open ? "is-open" : ""}`} />
        </button>
        {open && (
          <div className="model-select-menu" role="listbox" aria-label="选择模型">
            {models.map((option) => (
              <button
                key={option.id}
                role="option"
                aria-selected={option.id === modelId}
                className={`model-select-item ${option.id === modelId ? "active" : ""}`}
                onClick={() => pickRef.current(option)}
              >
                {modelIcon(option.provider, 14)}
                <span className="model-select-item-main">
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </span>
                <span className="model-select-item-badge">{option.badge}</span>
                {option.id === modelId && <Check size={13} className="model-select-check" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatPanel({ anchors, selectionGroup, conversation, conversations, activeConversationId, question, setQuestion, generating, pendingColor, onPendingColorChange, onChangeColor, contextMode, onToggleContext, translateMode, onTranslateModeChange, onPrompt, onSelectConversation, onDeleteTurn, provider, mode, modelLabel }: {
  anchors?: TextAnchor[];
  selectionGroup?: SelectionGroup;
  conversation?: Conversation;
  conversations: Conversation[];
  activeConversationId?: string;
  question: string;
  setQuestion: (value: string) => void;
  generating: boolean;
  pendingColor: HighlightColor;
  onPendingColorChange: (color: HighlightColor) => void;
  onChangeColor: (conversation: Conversation, color: HighlightColor) => void;
  contextMode: boolean;
  onToggleContext: () => void;
  translateMode: boolean;
  onTranslateModeChange: (value: boolean) => void;
  onPrompt: (kind: PromptKind) => void;
  onSelectConversation: (conversation: Conversation) => void;
  onDeleteTurn: (conversation: Conversation, turnId: string) => void;
  provider: ModelProvider;
  mode: ModelMode;
  modelLabel: string;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ turnId: string; nonce: number }>();
  const [selectionExpanded, setSelectionExpanded] = useState(false);
  // 提问索引只高亮"当前对话记录框中显示的那一条"，而不是整个会话的全部记录。
  const [activeTurnId, setActiveTurnId] = useState<string>();
  useEffect(() => {
    const lastUserTurn = [...(conversation?.turns ?? [])]
      .reverse()
      .find((turn) => turn.role === "user");
    setActiveTurnId(lastUserTurn?.id);
  }, [conversation?.id, conversation?.turns.length]);

  useEffect(() => {
    if (!focusRequest) return;
    const timer = window.setTimeout(() => {
      const target = historyRef.current?.querySelector<HTMLElement>(`[data-turn-id="${focusRequest.turnId}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("turn-flash");
      window.setTimeout(() => target.classList.remove("turn-flash"), 1800);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [focusRequest, conversation?.id]);

  useEffect(() => {
    setSelectionExpanded(false);
  }, [selectionGroup?.id]);

  const indexItems = useMemo(() => {
    const items: Array<{ conversation: Conversation; turn: ChatTurn }> = [];
    for (const item of conversations) {
      for (const turn of item.turns) {
        if (turn.role === "user") items.push({ conversation: item, turn });
      }
    }
    return items.sort((a, b) => b.turn.createdAt.localeCompare(a.turn.createdAt));
  }, [conversations]);

  function jumpToIndex(item: { conversation: Conversation; turn: ChatTurn }) {
    onSelectConversation(item.conversation);
    setActiveTurnId(item.turn.id);
    setFocusRequest((current) => ({ turnId: item.turn.id, nonce: (current?.nonce ?? 0) + 1 }));
  }

  const anchor = anchors?.[0];
  const selectionAnchors = selectionGroup?.anchors ?? (anchor ? [anchor] : []);
  const collapsedSelectionCount = selectionAnchors.length > 2 ? 2 : selectionAnchors.length;
  const visibleSelectionAnchors = selectionExpanded
    ? selectionAnchors
    : selectionAnchors.slice(0, collapsedSelectionCount);
  const hiddenSelectionCount = selectionAnchors.length - visibleSelectionAnchors.length;
  const activeColor = conversation?.color ?? pendingColor;
  const colorMode = conversation ? "会话" : "下一次提问";

  return <div className="chat-panel">
    <div className="panel-heading"><span className="panel-icon"><Bot size={17} /></span><div><h2>和论文聊一聊</h2><p>{selectionAnchors.length ? `当前选区 · ${selectionAnchors.length} 个片段` : "可自由提问，划选原文后会自动带上上下文"}</p></div><span className="chat-model-chip">{modelLabel}{mode === "deep" ? " · 思考" : ""}</span></div>
    <details className="question-index">
      <summary><MessageCircleMore size={14} /> 提问索引 <b>{indexItems.length}</b></summary>
      {indexItems.length ? (
        <div className="question-index-list">
          {indexItems.map((item) => (
            <div
              key={item.turn.id}
              className={`question-index-item ${item.turn.id === activeTurnId ? "active" : ""}`}
            >
              <button
                type="button"
                className="question-index-item-main"
                onClick={() => jumpToIndex(item)}
              >
                <span className="page">
                  {item.turn.selection?.anchors.length
                    ? `p.${[...new Set(item.turn.selection.anchors.map((entry) => entry.page))].join("/")}`
                    : `p.${item.conversation.anchor?.page ?? "全"}`}
                  {item.turn.kind === "context" || item.conversation.scope === "context" ? (
                    <span className="index-badge">全文</span>
                  ) : null}
                </span>
                <p>{item.turn.content}</p>
                <time>{readableDate(item.turn.createdAt)}</time>
              </button>
              <button
                type="button"
                className="question-index-item-delete"
                aria-label="删除这条问答记录"
                title="删除这条问答记录"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteTurn(item.conversation, item.turn.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="index-empty">还没有提问记录，划选原文后提出的问题会出现在这里。</p>}
    </details>
    {selectionAnchors.length ? (
      <div className="selection-card">
        <div className="selection-card-heading">
          <span>原文定位 · {selectionAnchors.length} 个片段</span>
          <b>{selectionAnchors.length > 1 ? "Ctrl/Cmd 追加" : "Ctrl/Cmd 划选追加"}</b>
        </div>
        <ol className="selection-fragment-list">
          {visibleSelectionAnchors.map((item, index) => {
            const excerpt = anchorExcerptParts(item.quote, 28, 28);
            return (
              <li key={item.id} title={item.quote}>
                <span className="selection-fragment-meta">
                  #{index + 1} · p.{item.page}{item.section ? ` · ${item.section}` : ""}
                </span>
                <span className="selection-fragment-quote">
                  <span className="selection-fragment-head">{excerpt.head}</span>
                  {excerpt.truncated ? (
                    <span className="selection-fragment-separator" aria-hidden="true">…</span>
                  ) : null}
                  {excerpt.truncated ? (
                    <span className="selection-fragment-tail">{excerpt.tail}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
        {hiddenSelectionCount > 0 ? (
          <button
            type="button"
            className={`selection-fragment-toggle ${selectionExpanded ? "expanded" : ""}`}
            aria-expanded={selectionExpanded}
            onClick={() => setSelectionExpanded((current) => !current)}
          >
            <span>{selectionExpanded ? "收起" : `显示其余 ${hiddenSelectionCount} 条`}</span>
            <ChevronRight size={12} />
          </button>
        ) : null}
      </div>
    ) : null}
    <div className="highlight-color-picker">
      <div className="highlight-color-picker-heading">
        <span>高亮颜色</span>
        <b>{colorMode}</b>
      </div>
      <div className="highlight-color-swatches" role="group" aria-label="选择高亮颜色">
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`highlight-color-swatch highlight-color-swatch-${color} ${activeColor === color ? "active" : ""}`}
            aria-label={`${color} 高亮`}
            aria-pressed={activeColor === color}
            title={color}
            onClick={() => {
              if (conversation) onChangeColor(conversation, color);
              else onPendingColorChange(color);
            }}
          />
        ))}
      </div>
    </div>
    <div className="chat-history" ref={historyRef} aria-live="polite">
      {conversation?.turns.length ? conversation.turns.map((turn) => (
        <div key={turn.id} data-turn-id={turn.id} className={`chat-turn ${turn.role}`}>
          <span>{turn.role === "user" ? "你" : "PaperMate"}</span>
          {turn.role === "user" ? (
            <div>{turn.content}</div>
          ) : (
            <div className="md-body">
              {turn.content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {turn.content}
                </ReactMarkdown>
              ) : <LoaderCircle className="spin" size={15} />}
            </div>
          )}
          {turn.role === "assistant" ? (
            <small>{turn.kind === "context" ? "全文上下文 · " : ""}{turn.selection?.anchors.length ? `依据第 ${[...new Set(turn.selection.anchors.map((entry) => entry.page))].join("、")} 页共 ${turn.selection.anchors.length} 个片段` : turn.anchor ? `依据第 ${turn.anchor.page} 页选段` : ""}</small>
          ) : null}
        </div>
      )) : <div className="chat-empty"><CircleHelp size={22} /><p>选中一句话，或提出关于整篇论文的问题。</p></div>}
    </div>
    <div className="quick-prompts">
      <button
        disabled={generating}
        className={translateMode ? "active" : ""}
        aria-pressed={translateMode}
        title="开启后划选原文自动翻译"
        onClick={() => {
          const next = !translateMode;
          onTranslateModeChange(next);
          // 已有选区时点击翻译：立即翻译，并保持翻译模式选中。
          if (next && selectionAnchors.length) onPrompt("translate");
        }}
      >翻译</button>
      <button
        disabled={generating}
        className={contextMode ? "active" : ""}
        aria-pressed={contextMode}
        onClick={onToggleContext}
      >结合上下文解释</button>
    </div>
    <div className="question-box"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="输入你的问题…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onPrompt(contextMode ? "context" : "free"); } }} /><button disabled={generating || !question.trim()} aria-label="发送问题" onClick={() => onPrompt(contextMode ? "context" : "free")}><SendHorizonal size={17} /></button></div>
    <p className="input-hint">{translateMode ? "翻译模式已开启 · 划选原文自动翻译（再次点击「翻译」关闭）" : contextMode ? "全文上下文已开启 · 以你的问题为核心结合全文回答" : "Enter 发送 · Shift + Enter 换行 · 回答优先依据论文原文"}</p>
  </div>;
}

function ArtifactPanel({ kind, paper, artifact, generating, onGenerate, onEdit, onDelete, onSaveVersion, onDeleteVersion }: {
  kind: ArtifactKind;
  paper: Paper;
  artifact?: GeneratedArtifact;
  generating: boolean;
  onGenerate: () => void;
  onEdit: (content: string) => void;
  onDelete: () => void;
  onSaveVersion: () => void;
  onDeleteVersion: (versionId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [viewingVersionId, setViewingVersionId] = useState<string | undefined>(undefined);
  const lastArtifactId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (artifact?.id && artifact.id !== lastArtifactId.current) {
      lastArtifactId.current = artifact.id;
      setEditing(false);
      setViewingVersionId(undefined);
    }
  }, [artifact?.id]);
  // 生成结束后回到当前版本视图。
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !generating) setViewingVersionId(undefined);
    wasGenerating.current = generating;
  }, [generating]);
  const details = artifactDetails[kind];
  const Icon = details.icon;
  const versions = artifact?.versions ?? [];
  const viewingVersion = viewingVersionId
    ? versions.find((version) => version.id === viewingVersionId)
    : undefined;
  const displayedContent = viewingVersion ? viewingVersion.content : artifact?.content;
  const svg = kind === "mindmap" && displayedContent ? mindMapToSvg(markdownToMindMap(displayedContent, paper.title)) : undefined;
  const download = () => {
    if (!artifact || !displayedContent) return;
    const stamp = viewingVersion
      ? `-历史版本-${viewingVersion.createdAt.slice(0, 10)}`
      : "";
    const base = `${paper.title}-${details.title}${stamp}`.replace(/[\\/:*?"<>|]/g, "-");
    if (kind === "mindmap" && svg) downloadFile(`${base}.svg`, svg, "image/svg+xml");
    else downloadFile(`${base}.md`, displayedContent, "text/markdown;charset=utf-8");
  };
  return <div className="artifact-panel">
    <div className="panel-heading"><span className="panel-icon"><Icon size={17} /></span><div><h2>{details.title}</h2><p>{details.description}</p></div></div>
    {!artifact?.content && !generating ? <div className="artifact-empty"><Icon size={28} /><h3>从这篇论文开始提炼</h3><p>将使用全文文本进行深度分析，生成结果自动保存到本机论文库。</p><button className="primary-action" onClick={onGenerate}><Sparkles size={16} /> 生成{details.title}</button></div> : <>
      {viewingVersion ? (
        <div className="artifact-version-banner">
          <span><Clock size={13} /> 正在查看历史版本 · {readableDateTime(viewingVersion.createdAt)}</span>
          <button type="button" onClick={download}><Download size={13} /> 下载此版本</button>
          <button type="button" className="primary" onClick={() => setViewingVersionId(undefined)}>返回当前版本</button>
        </div>
      ) : (
        <div className="artifact-actions">
          <button disabled={generating} onClick={onGenerate}>{generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{generating ? "正在分析" : "重新生成"}</button>
          <button disabled={!artifact?.content} onClick={download}><Download size={15} /> 保存本地</button>
          {artifact?.content ? <button disabled={generating} onClick={onSaveVersion}><Bookmark size={15} /> 保存版本</button> : null}
          {artifact?.content ? <button disabled={generating} onClick={() => setEditing((value) => !value)}>{editing ? "完成编辑" : "编辑文本"}</button> : null}
          {artifact?.content ? <button className="artifact-delete" disabled={generating} onClick={onDelete}><Trash2 size={15} /> 删除</button> : null}
        </div>
      )}
      {versions.length ? (
        <div className="artifact-versions">
          <div className="artifact-versions-head"><Clock size={11} /> 历史版本 <b>{versions.length}</b></div>
          <div className="artifact-versions-list">
            {versions.slice(0, MAX_ARTIFACT_VERSIONS).map((version) => (
              <button
                key={version.id}
                type="button"
                className={viewingVersionId === version.id ? "active" : ""}
                title={version.createdAt}
                onClick={() => setViewingVersionId(viewingVersionId === version.id ? undefined : version.id)}
              >
                {readableDateTime(version.createdAt)}
                <span
                  className="artifact-version-delete"
                  role="button"
                  aria-label="删除此历史版本"
                  title="删除此版本"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (viewingVersionId === version.id) setViewingVersionId(undefined);
                    onDeleteVersion(version.id);
                  }}
                >
                  <Trash2 size={11} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {artifact ? <p className="artifact-meta">生成于 {artifact.createdAt ? readableDateTime(artifact.createdAt) : ""} · 最后更新 {artifact.updatedAt ? readableDateTime(artifact.updatedAt) : ""}</p> : null}
      {kind === "mindmap" && svg && <div className="mindmap-preview" dangerouslySetInnerHTML={{ __html: svg }} />}
      {viewingVersion ? (
        <div className="artifact-md md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
            {viewingVersion.content}
          </ReactMarkdown>
        </div>
      ) : editing ? (
        <textarea className="artifact-editor" value={artifact?.content ?? ""} placeholder="正在生成内容…" onChange={(event) => onEdit(event.target.value)} />
      ) : (
        <div className="artifact-md md-body">
          {artifact?.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
              {artifact.content}
            </ReactMarkdown>
          ) : <LoaderCircle className="spin" size={16} />}
        </div>
      )}
    </>}
  </div>;
}

function SettingsSheet({ open, onClose, apiKey, setApiKey, state, onTest, glmApiKey, setGlmApiKey, glmState, onTestGlm, kimiApiKey, setKimiApiKey, kimiState, onTestKimi, theme, onThemeChange, backupState, backupSavedAt, backupFilePath, onBackupNow, onRestoreBackup, onExportBackup, onImportBackup, onCopyPath, customModels, onSaveCustomModel, onDeleteCustomModel, onTestCustomModel }: {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  state: "idle" | "testing" | "valid" | "invalid";
  onTest: () => void;
  glmApiKey: string;
  setGlmApiKey: (value: string) => void;
  glmState: "idle" | "testing" | "valid" | "invalid";
  onTestGlm: () => void;
  kimiApiKey: string;
  setKimiApiKey: (value: string) => void;
  kimiState: "idle" | "testing" | "valid" | "invalid";
  onTestKimi: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  backupState: "idle" | "saving" | "saved" | "error" | "restoring";
  backupSavedAt?: string;
  backupFilePath: string;
  onBackupNow: () => void;
  onRestoreBackup: () => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  onCopyPath: (ok: boolean) => void;
  customModels: CustomModelConfig[];
  onSaveCustomModel: (model: CustomModelConfig) => Promise<{ ok: boolean }>;
  onDeleteCustomModel: (id: string) => Promise<{ ok: boolean }>;
  onTestCustomModel: (input: { modelId?: string; baseUrl: string; model: string; apiKey?: string }) => Promise<{ ok: boolean; message?: string }>;
}) {
  const backupFileInputRef = useRef<HTMLInputElement>(null);

  // ---- 自定义模型编辑器状态 ----
  interface ModelDraft {
    id?: string;
    name: string;
    badge: string;
    description: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    params: string;
    deepParams: string;
    /** 编辑已有模型时的原 Key（表单留空则保留） */
    storedKey: string;
    createdAt?: string;
  }
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [draftTest, setDraftTest] = useState<"idle" | "testing" | "valid" | "invalid">("idle");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 关闭设置时收起模型编辑表单。
  useEffect(() => {
    if (open) return;
    setDraft(null);
    setDraftErrors([]);
    setDraftTest("idle");
    setConfirmDeleteId(null);
  }, [open]);

  const emptyDraft = (): ModelDraft => ({
    id: undefined,
    name: "",
    badge: "",
    description: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    params: "",
    deepParams: "",
    storedKey: "",
    createdAt: undefined,
  });

  function beginAddModel() {
    setDraft(emptyDraft());
    setDraftErrors([]);
    setDraftTest("idle");
  }

  function beginEditModel(model: CustomModelConfig) {
    setDraft({
      id: model.id,
      name: model.name,
      badge: model.badge ?? "",
      description: model.description ?? "",
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: "",
      params: model.params ? JSON.stringify(model.params, null, 2) : "",
      deepParams: model.deepParams ? JSON.stringify(model.deepParams, null, 2) : "",
      storedKey: model.apiKey ?? "",
      createdAt: model.createdAt,
    });
    setDraftErrors([]);
    setDraftTest("idle");
  }

  async function saveDraft() {
    if (!draft) return;
    const result = validateCustomModel({
      id: draft.id,
      name: draft.name,
      badge: draft.badge,
      description: draft.description,
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey.trim() || draft.storedKey,
      params: draft.params,
      deepParams: draft.deepParams,
      createdAt: draft.createdAt,
    });
    if (!result.ok) {
      setDraftErrors(result.errors);
      return;
    }
    const outcome = await onSaveCustomModel(result.value);
    if (outcome.ok) setDraft(null);
  }

  async function testDraft() {
    if (!draft) return;
    setDraftTest("testing");
    const outcome = await onTestCustomModel({
      modelId: draft.id,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim() || draft.storedKey,
    });
    setDraftTest(outcome.ok ? "valid" : "invalid");
  }

  async function confirmDeleteModel(model: CustomModelConfig) {
    setConfirmDeleteId(null);
    await onDeleteCustomModel(model.id);
  }

  async function copyBackupPath() {
    try {
      await copyTextToClipboard(backupFilePath);
      onCopyPath(true);
    } catch {
      onCopyPath(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onClick={onClose}
    >
      <div className="settings-sheet" onClick={(event) => event.stopPropagation()}>
        <button className="close-sheet" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
        <div className="settings-scroll">
          <div className="settings-header">
            <div>
              <span className="settings-kicker">SETTINGS</span>
              <h2>设置</h2>
              <p>模型连接、阅读主题与本机备份，统一在这里管理。</p>
            </div>
            <button type="button" className="settings-done" onClick={onClose}><Check size={15} /> 完成</button>
          </div>
          <div className="settings-layout">
            <div className="settings-layout-main">
              <section className="settings-block">
                <div className="settings-block-head">
                  <span className="settings-kicker">MODEL PROVIDERS</span>
                  <h3>模型连接</h3>
                  <p>API Key 明文保存在本机 data/apikey.txt，不会上传，也不会提交到代码仓库。</p>
                </div>
                <div className="settings-api-grid">
                  <section className="settings-api-card">
                    <div className="settings-api-title"><BrainCircuit size={17} /><div><b>DeepSeek</b><span>Flash 快速回复，可切换深度思考</span></div></div>
                    <label>DeepSeek API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (apiKey.trim()) onClose(); } }} placeholder="sk-…" autoComplete="off" /></label>
                    <button className="test-key" disabled={!apiKey.trim() || state === "testing"} onClick={onTest}>{state === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{state === "testing" ? "验证中" : "验证连接"}</button>
                    {state === "valid" && <p className="key-result good">连接成功，可以开始提问。</p>}
                    {state === "invalid" && <p className="key-result bad">连接失败，请检查 Key、额度或网络。</p>}
                  </section>
                  <section className="settings-api-card">
                    <div className="settings-api-title"><Sparkles size={17} /><div><b>智谱 GLM Flash</b><span>免费模型：快速 GLM-4-Flash · 深度 4.7-Flash，支持并发</span></div></div>
                    <label>智谱 API Key<input type="password" value={glmApiKey} onChange={(event) => setGlmApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (glmApiKey.trim()) onClose(); } }} placeholder="智谱 API Key" autoComplete="off" /></label>
                    <button className="test-key" disabled={!glmApiKey.trim() || glmState === "testing"} onClick={onTestGlm}>{glmState === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{glmState === "testing" ? "验证中" : "验证连接"}</button>
                    {glmState === "valid" && <p className="key-result good">连接成功，可以开始提问。</p>}
                    {glmState === "invalid" && <p className="key-result bad">连接失败，请检查 Key、额度或网络。</p>}
                  </section>
                  <section className="settings-api-card">
                    <div className="settings-api-title"><Moon size={17} /><div><b>Kimi K2.6</b><span>长上下文深度推理，可切换快速/深度思考</span></div></div>
                    <label>Moonshot API Key<input type="password" value={kimiApiKey} onChange={(event) => setKimiApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (kimiApiKey.trim()) onClose(); } }} placeholder="sk-…" autoComplete="off" /></label>
                    <button className="test-key" disabled={!kimiApiKey.trim() || kimiState === "testing"} onClick={onTestKimi}>{kimiState === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{kimiState === "testing" ? "验证中" : "验证连接"}</button>
                    {kimiState === "valid" && <p className="key-result good">连接成功，可以开始提问。</p>}
                    {kimiState === "invalid" && <p className="key-result bad">连接失败，请检查 Key、额度或网络。</p>}
                  </section>
                </div>
              </section>
              <section className="settings-theme-section">
                <span className="settings-kicker">READING THEME</span>
                <h3>阅读主题</h3>
                <div className="settings-theme-grid" role="radiogroup" aria-label="阅读主题">
                  {THEMES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={theme === item.id}
                      className={`settings-theme-option ${theme === item.id ? "active" : ""}`}
                      onClick={() => onThemeChange(item.id)}
                    >
                      <span className="settings-theme-swatch" style={item.swatch} />
                      <span>
                        <b>{item.name}</b>
                        <small>{item.description}</small>
                      </span>
                      {theme === item.id && <Check size={13} className="theme-menu-check" />}
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-block settings-models-section">
                <div className="settings-block-head">
                  <span className="settings-kicker">CUSTOM MODELS</span>
                  <h3>自定义模型</h3>
                  <p>内置模型（GLM-4-Flash / GLM-4.7-Flash / DeepSeek Flash / Kimi K2.6）保持不变，在上方卡片配置各自 API Key；下方可自由添加任意 OpenAI 兼容模型，自定义请求地址、模型名、Key 与参数。配置保存在 data/models.json，仅本机、不进备份。</p>
                </div>
                {customModels.length ? (
                  <div className="settings-model-list">
                    {customModels.map((model) => (
                      <div key={model.id} className={`settings-model-row ${confirmDeleteId === model.id ? "is-confirming" : ""}`}>
                        <div className="settings-model-row-main">
                          <b>{model.name}</b>
                          <span className="settings-model-badge">{model.badge || CUSTOM_MODEL_BADGE}</span>
                          <small title={`${model.baseUrl} · ${model.model}`}>{model.baseUrl} · {model.model}</small>
                        </div>
                        <span className={`settings-model-key-state ${model.apiKey?.trim() ? "ok" : ""}`}>
                          {model.apiKey?.trim() ? "已配置 Key" : "未配置 Key"}
                        </span>
                        <div className="settings-model-row-actions">
                          <button type="button" onClick={() => beginEditModel(model)}>编辑</button>
                          {confirmDeleteId === model.id ? (
                            <>
                              <button type="button" className="danger" onClick={() => void confirmDeleteModel(model)}>确认删除</button>
                              <button type="button" onClick={() => setConfirmDeleteId(null)}>取消</button>
                            </>
                          ) : (
                            <button type="button" className="danger" onClick={() => setConfirmDeleteId(model.id)}>删除</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="settings-model-empty">还没有自定义模型。点击下方「添加模型」接入任意 OpenAI 兼容服务。</p>
                )}
                {!draft && (
                  <button type="button" className="settings-add-model" onClick={beginAddModel}><Plus size={14} /> 添加模型</button>
                )}
                {draft && (
                  <div className="settings-model-form">
                    <div className="settings-model-form-head">
                      <b>{draft.id ? "编辑模型" : "添加模型"}</b>
                      <button type="button" className="settings-model-form-close" aria-label="关闭表单" title="关闭" onClick={() => setDraft(null)}><X size={14} /></button>
                    </div>
                    <div className="settings-model-form-grid">
                      <label>名称 *<input type="text" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：我的本地模型" autoComplete="off" /></label>
                      <label>徽标<input type="text" value={draft.badge} onChange={(event) => setDraft({ ...draft, badge: event.target.value })} placeholder="例如：内网 · 快" autoComplete="off" /></label>
                    </div>
                    <label>描述<input type="text" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="一句话介绍这个模型（可选）" autoComplete="off" /></label>
                    <label>请求地址 *<input type="text" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1/chat/completions" autoComplete="off" spellCheck={false} /></label>
                    <label>模型名 *<input type="text" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="例如：gpt-4o-mini" autoComplete="off" spellCheck={false} /></label>
                    <label>API Key<input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.storedKey ? "留空则保留已保存的 Key" : "sk-…"} autoComplete="off" /></label>
                    <label>请求参数（JSON，可选）<textarea rows={3} value={draft.params} onChange={(event) => setDraft({ ...draft, params: event.target.value })} placeholder='{"temperature": 0.7, "max_tokens": 2048}' spellCheck={false} /></label>
                    <label>深度模式参数（JSON，可选）<textarea rows={2} value={draft.deepParams} onChange={(event) => setDraft({ ...draft, deepParams: event.target.value })} placeholder='{"reasoning_effort": "high"}' spellCheck={false} /></label>
                    {draftErrors.length ? <p className="settings-model-form-errors">{draftErrors.join("；")}</p> : null}
                    {draftTest === "valid" ? <p className="key-result good">连接成功，可以开始提问。</p> : null}
                    {draftTest === "invalid" ? <p className="key-result bad">连接失败，请检查请求地址、API Key 与模型名。</p> : null}
                    <div className="settings-model-form-actions">
                      <button type="button" className="test-key" disabled={!draft.baseUrl.trim() || !draft.model.trim() || draftTest === "testing"} onClick={() => void testDraft()}>{draftTest === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{draftTest === "testing" ? "测试中" : "测试连接"}</button>
                      <button type="button" className="primary" onClick={() => void saveDraft()}><Check size={14} /> 保存</button>
                      <button type="button" onClick={() => setDraft(null)}>取消</button>
                    </div>
                  </div>
                )}
              </section>
            </div>
            <aside className="settings-layout-side">
              <section className="settings-backup-section">
                <span className="settings-kicker">LOCAL BACKUP</span>
                <h3>完整 JSON 备份</h3>
                <p className={`backup-status ${backupState === "error" ? "error" : ""}`}>
                  {backupState === "saving"
                    ? "正在生成完整 JSON…"
                    : backupState === "restoring"
                      ? "正在从备份恢复…"
                      : backupState === "error"
                        ? "完整 JSON 备份失败，请检查磁盘"
                        : backupSavedAt
                          ? `最近手动备份 · ${readableDateTime(backupSavedAt)}`
                          : "数据库自动保存；完整 JSON 手动导出、导入和立即备份"}
                </p>
                <div className="backup-path-row">
                  <span>备份文件</span>
                  <code title={backupFilePath}>{backupFilePath}</code>
                  <button type="button" className="backup-path-copy" onClick={() => void copyBackupPath()}>
                    <Copy size={13} />
                    复制路径
                  </button>
                </div>
                <input
                  ref={backupFileInputRef}
                  className="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) onImportBackup(file);
                    event.currentTarget.value = "";
                  }}
                />
                <div className="backup-actions">
                  <button
                    type="button"
                    className="backup-action primary"
                    disabled={backupState === "saving" || backupState === "restoring"}
                    onClick={onBackupNow}
                  >
                    {backupState === "saving" ? <LoaderCircle className="spin" size={14} /> : <HardDrive size={14} />}
                    立即备份
                  </button>
                  <button
                    type="button"
                    className="backup-action"
                    disabled={backupState === "saving" || backupState === "restoring"}
                    onClick={onRestoreBackup}
                  >
                    <RefreshCw size={14} />
                    从备份恢复
                  </button>
                  <button
                    type="button"
                    className="backup-action"
                    disabled={backupState === "saving" || backupState === "restoring"}
                    onClick={onExportBackup}
                  >
                    <Download size={14} />
                    导出备份文件
                  </button>
                  <button
                    type="button"
                    className="backup-action"
                    disabled={backupState === "saving" || backupState === "restoring"}
                    onClick={() => backupFileInputRef.current?.click()}
                  >
                    <Upload size={14} />
                    导入备份
                  </button>
                </div>
              </section>
              <div className="mode-info"><div><b>快速 · Flash</b><span>翻译、基础问答</span></div><div><b>深度 · MAX 思考</b><span>解释、总结、写作分析</span></div><div><b>DeepSeek</b><span>独立 API Key</span></div><div><b>GLM Flash</b><span>免费 · 4-Flash / 4.7-Flash · 并发</span></div></div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
