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
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  MessageCircleMore,
  Network,
  Palette,
  PanelLeftClose,
  PanelRightClose,
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
import {
  deletePaper,
  findPaperBySourceHash,
  getWorkspace,
  listPapers,
  listWorkspaces,
  replaceAll,
  savePaper,
  saveWorkspace,
  updatePaperNote,
} from "@/lib/db";
import {
  backupToPaper,
  buildBackup,
  isBackup,
  type BackupSettings,
  type PaperMateBackup,
} from "@/lib/backup";
import {
  anchorExcerptParts,
  buildContext,
  defaultHighlightColor,
  deriveHighlightRegions,
  HIGHLIGHT_COLORS,
  MAX_SELECTION_FRAGMENTS,
  selectionGroupForAnchors,
} from "@/lib/pdf";
import { markdownToMindMap, mindMapToSvg } from "@/lib/mindmap";
import { READER_QUOTES } from "@/lib/quotes";
import { blobSha256 } from "@/lib/source-hash";
import type {
  ArtifactKind,
  ChatTurn,
  Conversation,
  GeneratedArtifact,
  HighlightColor,
  ModelMode,
  Paper,
  PaperWorkspace,
  PromptKind,
  SelectionGroup,
  TextAnchor,
} from "@/lib/types";

type RightView = "chat" | ArtifactKind;

const THEME_KEY = "papermate-theme-v1";
const BACKUP_FILE_PATH = "data/papermate-backup.json";
type ThemeId = "classic" | "paper-white" | "bean-green" | "parchment" | "dark" | "cyberpunk" | "mono" | "academic-blue" | "morandi" | "noble";
const THEME_IDS: ThemeId[] = ["classic", "paper-white", "bean-green", "parchment", "dark", "cyberpunk", "mono", "academic-blue", "morandi", "noble"];
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
];

const blankWorkspace: PaperWorkspace = { annotations: [], conversations: [], artifacts: [] };
const artifactDetails: Record<ArtifactKind, { title: string; description: string; icon: typeof FileText }> = {
  notes: { title: "阅读笔记", description: "提炼问题、贡献、方法、证据与启发", icon: FileText },
  mindmap: { title: "论文脑图", description: "用可折叠的论证结构理解全篇", icon: Network },
  writing: { title: "写作思路", description: "拆解论证、结构和表达策略", icon: WandSparkles },
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

function downloadFile(name: string, content: string, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
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

interface BackupFetchResult extends PaperMateBackup {
  filePath?: string;
}

async function fetchBackup(): Promise<BackupFetchResult> {
  const response = await fetch("/api/storage/backup", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取本机备份。");
  const data = (await response.json()) as Partial<PaperMateBackup> & { filePath?: string };
  return {
    version: 1,
    savedAt: data.savedAt ?? "",
    papers: data.papers ?? [],
    workspaces: data.workspaces ?? [],
    filePath: data.filePath,
  };
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [paper, setPaper] = useState<Paper>();
  const [activeSectionId, setActiveSectionId] = useState<string>();
  const [chapterScrollRequest, setChapterScrollRequest] = useState<{
    page: number;
    nonce: number;
  }>();
  const [workspace, setWorkspace] = useState<PaperWorkspace>(blankWorkspace);
  const [activeAnchors, setActiveAnchors] = useState<TextAnchor[]>([]);
  const [rightView, setRightView] = useState<RightView>("chat");
  const [apiKey, setApiKey] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>("classic");
  const [keyState, setKeyState] = useState<"idle" | "testing" | "valid" | "invalid">("idle");
  const [mode, setMode] = useState<ModelMode>("fast");
  const [question, setQuestion] = useState("");
  const [generating, setGenerating] = useState(false);
  const [pendingColor, setPendingColor] = useState<HighlightColor>(HIGHLIGHT_COLORS[0]);
  const [uploadState, setUploadState] = useState<"idle" | "loading" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [libraryQuery, setLibraryQuery] = useState("");
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
  const backupTimerRef = useRef<number | undefined>(undefined);
  const backupInFlightRef = useRef(false);
  const backupDirtyRef = useRef(false);
  const themeRef = useRef<ThemeId>("classic");
  themeRef.current = theme;
  const layoutRef = useRef({ leftWidth, rightWidth, leftCollapsed, rightCollapsed });
  layoutRef.current = { leftWidth, rightWidth, leftCollapsed, rightCollapsed };
  const LAYOUT_KEY = "papermate-layout-v1";
  const activeAnchor = activeAnchors[0];
  const activeSelection = useMemo(
    () => selectionGroupForAnchors(paper?.id ?? "", activeAnchors),
    [activeAnchors, paper?.id],
  );
  const highlightRegions = useMemo(
    () => deriveHighlightRegions(workspace.conversations),
    [workspace.conversations],
  );
  const visiblePapers = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    if (!query) return papers;
    return papers.filter((item) =>
      [item.title, item.fileName, item.note ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [libraryQuery, papers]);

  const writeBackupNow = useCallback(async () => {
    if (backupInFlightRef.current) {
      backupDirtyRef.current = true;
      return;
    }
    backupInFlightRef.current = true;
    setBackupState("saving");
    try {
      const [currentPapers, currentWorkspaces] = await Promise.all([
        listPapers(),
        listWorkspaces(),
      ]);
      const backup = await buildBackup(currentPapers, currentWorkspaces, {
        theme: themeRef.current,
        layout: layoutRef.current,
      });
      const response = await fetch("/api/storage/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup),
      });
      if (!response.ok) throw new Error("backup-write-failed");
      const result = (await response.json()) as { savedAt?: string; filePath?: string };
      setBackupSavedAt(result.savedAt || backup.savedAt);
      if (result.filePath) setBackupFilePath(result.filePath);
      setBackupState("saved");
    } catch {
      setBackupState("error");
      setNotice("本机磁盘备份失败，请检查磁盘空间或读写权限。");
    } finally {
      backupInFlightRef.current = false;
      if (backupDirtyRef.current) {
        backupDirtyRef.current = false;
        void writeBackupNow();
      }
    }
  }, []);

  const scheduleBackup = useCallback((delay = 1200) => {
    backupDirtyRef.current = true;
    if (backupTimerRef.current !== undefined) {
      window.clearTimeout(backupTimerRef.current);
    }
    backupTimerRef.current = window.setTimeout(() => {
      backupTimerRef.current = undefined;
      backupDirtyRef.current = false;
      void writeBackupNow();
    }, delay);
  }, [writeBackupNow]);

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
    setBackupState("restoring");
    try {
      const backup = await fetchBackup();
      const restoredPapers = backup.papers.map(backupToPaper);
      await replaceAll(restoredPapers, backup.workspaces);
      setPapers(restoredPapers);
      setPaper(undefined);
      setBackupSavedAt(backup.savedAt || undefined);
      applyBackupSettings(backup.settings);
      setNotice(
        restoredPapers.length || backup.workspaces.length
          ? `已从本机磁盘备份恢复 ${restoredPapers.length} 篇论文。`
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
      const [currentPapers, currentWorkspaces] = await Promise.all([
        listPapers(),
        listWorkspaces(),
      ]);
      const backup = await buildBackup(currentPapers, currentWorkspaces, {
        theme: themeRef.current,
        layout: layoutRef.current,
      });
      const stamp = (backup.savedAt || new Date().toISOString()).slice(0, 10);
      downloadFile(
        `papermate-backup-${stamp}.json`,
        JSON.stringify(backup, null, 2),
        "application/json",
      );
      setNotice(`已导出 ${currentPapers.length} 篇论文的备份文件，可复制到其他项目后导入。`);
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
    setBackupState("restoring");
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isBackup(parsed)) throw new Error("invalid-backup");
      const restoredPapers = parsed.papers.map(backupToPaper);
      await replaceAll(restoredPapers, parsed.workspaces);
      setPapers(restoredPapers);
      setPaper(undefined);
      setBackupSavedAt(parsed.savedAt || new Date().toISOString());
      applyBackupSettings(parsed.settings);
      setNotice(`已从备份文件导入 ${restoredPapers.length} 篇论文和本地成果。`);
      setBackupState("saved");
      void writeBackupNow();
    } catch {
      setBackupState("error");
      setNotice("无法导入备份：文件不是有效的 PaperMate 备份。");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await listPapers();
        const backup = await fetchBackup().catch(() => undefined);
        if (cancelled) return;
        if (backup?.filePath) setBackupFilePath(backup.filePath);
        if (stored.length) {
          setPapers(stored);
          if (backup?.savedAt) setBackupSavedAt(backup.savedAt);
          return;
        }
        const restoredPapers = backup ? backup.papers.map(backupToPaper) : [];
        await replaceAll(restoredPapers, backup?.workspaces ?? []);
        if (cancelled) return;
        setPapers(restoredPapers);
        if (backup?.savedAt) setBackupSavedAt(backup.savedAt);
        applyBackupSettings(backup?.settings);
        if (restoredPapers.length || backup?.workspaces.length) {
          setNotice(`已从本机磁盘备份恢复 ${restoredPapers.length} 篇论文和本地成果。`);
        }
      } catch {
        if (!cancelled) setNotice("无法打开本地论文库。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBackupSettings]);

  const hasBackupData =
    papers.length > 0 ||
    workspace.annotations.length > 0 ||
    workspace.conversations.length > 0 ||
    workspace.artifacts.length > 0;

  useEffect(() => {
    if (!hasBackupData) return;
    scheduleBackup(1200);
    return () => {
      if (backupTimerRef.current !== undefined) {
        window.clearTimeout(backupTimerRef.current);
        backupTimerRef.current = undefined;
      }
    };
  }, [hasBackupData, papers, scheduleBackup, workspace]);

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
  }, [theme]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as {
          leftWidth?: number;
          rightWidth?: number;
          leftCollapsed?: boolean;
          rightCollapsed?: boolean;
        };
        if (typeof saved.leftWidth === "number") setLeftWidth(Math.min(420, Math.max(170, saved.leftWidth)));
        if (typeof saved.rightWidth === "number") setRightWidth(Math.min(620, Math.max(300, saved.rightWidth)));
        setLeftCollapsed(Boolean(saved.leftCollapsed));
        setRightCollapsed(Boolean(saved.rightCollapsed));
      }
    } catch {
      // 布局设置损坏时忽略
    }
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
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    if (!paper) {
      setWorkspace(blankWorkspace);
      return;
    }
    setActiveAnchors([]);
    setActiveConversationId(undefined);
    setPendingColor(defaultHighlightColor(0));
    void getWorkspace(paper.id).then(setWorkspace).catch(() => setNotice("无法读取这篇论文的本地笔记。"));
  }, [paper]);

  const onActiveSectionChange = useCallback((sectionId?: string) => {
    setActiveSectionId(sectionId);
  }, []);

  const selectedConversation = useMemo(() => {
    const byId = workspace.conversations.find((conversation) => conversation.id === activeConversationId);
    if (byId) return byId;
    if (activeSelection) {
      return workspace.conversations.find(
        (conversation) =>
          conversation.selection?.id === activeSelection.id ||
          conversation.anchor?.id === activeSelection.anchors[0]?.id,
      );
    }
    return workspace.conversations.find((conversation) => conversation.anchor?.id === activeAnchor?.id) ??
      workspace.conversations.at(0);
  }, [activeAnchor?.id, activeConversationId, activeSelection, workspace.conversations]);

  function commitWorkspace(next: PaperWorkspace) {
    setWorkspace(next);
    if (paper) void saveWorkspace(paper.id, next);
  }

  function startResize(which: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    if (isCompact || isMobile) return;
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (which === "left") {
        const maxLeft = Math.min(420, Math.max(170, window.innerWidth - rightWidth - 380 - 28));
        setLeftWidth(Math.min(maxLeft, Math.max(170, startLeft + delta)));
      } else {
        const maxRight = Math.min(620, Math.max(300, window.innerWidth - leftWidth - 380 - 28));
        setRightWidth(Math.min(maxRight, Math.max(300, startRight - delta)));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function handleFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("请导入 PDF 文件。本版本暂不支持 DOCX 与扫描件 OCR。");
      return;
    }
    setUploadState("loading");
    setNotice(undefined);
    try {
      const sourceHash = await blobSha256(file);
      const existing = await findPaperBySourceHash(sourceHash);
      if (existing) {
        setPapers((current) => {
          const others = current.filter((item) => item.id !== existing.id);
          return [existing, ...others];
        });
        setPaper(existing);
        setNotice(`《${existing.title}》已经在本机论文库中，已直接打开。`);
        setUploadState("idle");
        return;
      }
      const parsed = await parsePdfFile(file);
      const now = new Date().toISOString();
      const title = file.name.replace(/\.pdf$/i, "");
      const nextPaper: Paper = {
        id: uid(),
        title,
        fileName: file.name,
        file,
        sourceHash,
        createdAt: now,
        updatedAt: now,
        ...parsed,
      };
      await savePaper(nextPaper);
      setPapers((current) => [nextPaper, ...current]);
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

  async function openPaper(item: Paper) {
    setPaper(item);
    if (item.originalReady) return;
    setNotice("正在补齐这篇论文的原版排版数据…");
    const repaired = await repairPaperOriginalMetadata(item);
    setPaper(repaired);
    setPapers((items) => items.map((entry) => (entry.id === repaired.id ? repaired : entry)));
    await savePaper(repaired);
    setNotice(repaired.originalReady ? "已补齐原版排版数据。" : "未读取到文本层，仍会显示原版页面。");
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
        (conversation) => conversation.selection?.id === nextSelection?.id,
      ) ??
      workspace.conversations.find((conversation) => conversation.anchor?.id === anchor.id);
    setActiveConversationId(existing?.id);
    setPendingColor(defaultHighlightColor(workspace.conversations.length));
    setRightView("chat");
    if (additive && nextAnchors.length === MAX_SELECTION_FRAGMENTS) {
      setNotice(`一次最多组合 ${MAX_SELECTION_FRAGMENTS} 个片段。`);
    }
  }

  function clearActiveSelection() {
    setActiveAnchors([]);
    setActiveConversationId(undefined);
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
    setRightView("chat");
  }

  function updateConversation(conversation: Conversation) {
    const exists = workspace.conversations.some((item) => item.id === conversation.id);
    const next = {
      ...workspace,
      conversations: exists
        ? workspace.conversations.map((item) => (item.id === conversation.id ? conversation : item))
        : [conversation, ...workspace.conversations],
    };
    commitWorkspace(next);
  }

  function changeConversationColor(conversation: Conversation, color: HighlightColor) {
    updateConversation({ ...conversation, color, updatedAt: new Date().toISOString() });
  }

  async function streamResponse(
    task: PromptKind | ArtifactKind,
    taskQuestion: string,
    context: string,
    previousTurns: ChatTurn[] = [],
    onText: (content: string) => void,
  ) {
    const response = await fetch("/api/deepseek/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        mode,
        task,
        context,
        question: taskQuestion,
        messages: previousTurns.slice(-10).map((turn) => ({ role: turn.role, content: turn.content })),
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
  }

  async function sendQuestion(kind: PromptKind, forcedQuestion?: string) {
    if (!paper || generating) return;
    if (!apiKey.trim()) {
      setSettingsOpen(true);
      setNotice("请先在设置中填写并验证你的 DeepSeek API Key。" );
      return;
    }
    const requestedQuestion = forcedQuestion?.trim() || question.trim() || (kind === "free" ? "请解释这段内容。" : promptLabels[kind]);
    if (!activeAnchors.length && kind !== "free") {
      setNotice("先在原版页面上划选一段原文。" );
      return;
    }
    const now = new Date().toISOString();
    const conversation = selectedConversation ?? {
      id: uid(),
      paperId: paper.id,
      anchor: activeAnchor,
      selection: activeSelection,
      color: pendingColor ?? defaultHighlightColor(workspace.conversations.length),
      title: activeSelection
        ? activeSelection.anchors.length > 1
          ? `${activeSelection.anchors.length} 个片段问答`
          : `${activeSelection.anchors[0].section ?? `第 ${activeSelection.anchors[0].page} 页`}选段`
        : "全文问答",
      turns: [],
      updatedAt: now,
    };
    const userTurn: ChatTurn = {
      id: uid(),
      role: "user",
      content: requestedQuestion,
      createdAt: now,
      mode,
      kind,
      anchor: activeAnchor,
      selection: activeSelection,
    };
    const assistantTurn: ChatTurn = {
      id: uid(),
      role: "assistant",
      content: "",
      createdAt: now,
      mode,
      kind,
      anchor: activeAnchor,
      selection: activeSelection,
    };
    let currentConversation = {
      ...conversation,
      anchor: activeAnchor,
      selection: activeSelection,
      turns: [...conversation.turns, userTurn, assistantTurn],
      updatedAt: now,
    };
    updateConversation(currentConversation);
    setActiveConversationId(currentConversation.id);
    setPendingColor(defaultHighlightColor(workspace.conversations.length + 1));
    setQuestion("");
    setGenerating(true);
    try {
      await streamResponse(kind, requestedQuestion, buildContext(paper.pages, activeAnchors), conversation.turns, (content) => {
        currentConversation = {
          ...currentConversation,
          turns: currentConversation.turns.map((turn) => (turn.id === assistantTurn.id ? { ...turn, content } : turn)),
          updatedAt: new Date().toISOString(),
        };
        updateConversation(currentConversation);
      });
    } catch (error) {
      const content = `请求未完成：${error instanceof Error ? error.message : "未知错误"}`;
      currentConversation = {
        ...currentConversation,
        turns: currentConversation.turns.map((turn) => (turn.id === assistantTurn.id ? { ...turn, content } : turn)),
        updatedAt: new Date().toISOString(),
      };
      updateConversation(currentConversation);
    } finally {
      setGenerating(false);
    }
  }

  async function generateArtifact(kind: ArtifactKind) {
    if (!paper || generating) return;
    if (!apiKey.trim()) {
      setSettingsOpen(true);
      setNotice("请先在设置中填写并验证你的 DeepSeek API Key。" );
      return;
    }
    setGenerating(true);
    const details = artifactDetails[kind];
    const draft: GeneratedArtifact = {
      id: uid(),
      paperId: paper.id,
      kind,
      title: details.title,
      content: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let artifact = draft;
    const start = { ...workspace, artifacts: [draft, ...workspace.artifacts.filter((item) => item.kind !== kind)] };
    commitWorkspace(start);
    try {
      await streamResponse(kind, `请分析《${paper.title}》。`, documentContext(paper), [], (content) => {
        artifact = { ...artifact, content, updatedAt: new Date().toISOString() };
        commitWorkspace({ ...workspace, artifacts: [artifact, ...workspace.artifacts.filter((item) => item.kind !== kind)] });
      });
    } catch (error) {
      artifact = { ...artifact, content: `生成失败：${error instanceof Error ? error.message : "未知错误"}`, updatedAt: new Date().toISOString() };
      commitWorkspace({ ...workspace, artifacts: [artifact, ...workspace.artifacts.filter((item) => item.kind !== kind)] });
    } finally {
      setGenerating(false);
    }
  }

  function editArtifact(kind: ArtifactKind, content: string) {
    const current = workspace.artifacts.find((item) => item.kind === kind);
    if (!current) return;
    const next = { ...current, content, updatedAt: new Date().toISOString() };
    commitWorkspace({ ...workspace, artifacts: workspace.artifacts.map((item) => (item.id === next.id ? next : item)) });
  }

  async function testKey() {
    if (!apiKey.trim()) return;
    setKeyState("testing");
    try {
      const response = await fetch("/api/deepseek/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      setKeyState(response.ok ? "valid" : "invalid");
    } catch {
      setKeyState("invalid");
    }
  }

  async function removePaper(id: string) {
    await deletePaper(id);
    setPapers((items) => items.filter((item) => item.id !== id));
    if (editingNotePaperId === id) setEditingNotePaperId(undefined);
    if (paper?.id === id) setPaper(undefined);
    void writeBackupNow();
  }

  function beginNoteEdit(item: Paper) {
    setEditingNotePaperId(item.id);
    setNoteDraft(item.note ?? "");
  }

  function closeNoteEditor() {
    setEditingNotePaperId(undefined);
    setNoteDraft("");
  }

  async function saveNote(item: Paper) {
    const note = noteDraft.trim();
    setPapers((items) =>
      items.map((entry) => (entry.id === item.id ? { ...entry, note } : entry)),
    );
    if (paper?.id === item.id) setPaper((current) => (current ? { ...current, note } : current));
    await updatePaperNote(item.id, note);
    closeNoteEditor();
  }

  if (!paper) {
    return (
      <main className="landing-shell">
        <header className="landing-header">
          <Brand />
          <div className="header-actions">
            <ThemeSwitcher theme={theme} onChange={setTheme} />
            <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> 模型设置</button>
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
          <div className="section-label"><FolderOpen size={17} /> 本地论文库 <span>{visiblePapers.length}</span></div>
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
              ? "正在写入本机磁盘…"
              : backupState === "restoring"
                ? "正在从备份恢复…"
                : backupState === "error"
                  ? "本机备份失败，请检查磁盘"
                  : backupSavedAt
                    ? `本机磁盘自动备份 · ${readableDateTime(backupSavedAt)}`
                    : "本机磁盘自动备份已开启"}
          </p>
          {visiblePapers.length ? (
            <div className="library-grid">
              {visiblePapers.map((item) => (
                <article className="paper-card" key={item.id}>
                  <button className="paper-card-open" onClick={() => void openPaper(item)}>
                    <span className="paper-icon"><FileText size={22} /></span>
                    <strong>{item.title}</strong>
                    <small>{item.pageCount} 页 · {readableDate(item.updatedAt)} 保存</small>
                    <ChevronRight size={17} />
                  </button>
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
                  <button className="paper-remove" aria-label={`删除 ${item.title}`} onClick={() => void removePaper(item.id)}><Trash2 size={15} /></button>
                </article>
              ))}
            </div>
          ) : papers.length ? (
            <p className="empty-library">没有匹配的论文，换个关键词试试。</p>
          ) : (
            <p className="empty-library">还没有论文。首次导入后，文件和成果会保存到本机，并自动写入磁盘备份。</p>
          )}
        </section>
        <SettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          apiKey={apiKey}
          setApiKey={setApiKey}
          state={keyState}
          onTest={() => void testKey()}
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
        />
      </main>
    );
  }

  const artifact = rightView === "chat" ? undefined : workspace.artifacts.find((item) => item.kind === rightView);
  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <button className="brand-small" onClick={() => setPaper(undefined)} aria-label="返回论文库"><PanelLeftClose size={17} /><span>返 回 论 文 库</span></button>
        <div className="paper-title"><FileText size={16} /><strong>{paper.title}</strong><span>{paper.pageCount} 页 · 本地保存</span></div>
        <div className="header-actions">
          {notice && <span className="compact-notice">{notice}</span>}
          <ThemeSwitcher theme={theme} onChange={setTheme} />
          <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> API 设置</button>
        </div>
      </header>
      <div
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
            <button className={rightView === "chat" ? "active" : ""} onClick={() => setRightView("chat")}><MessageCircleMore size={17} /> 选段问答</button>
            {(Object.keys(artifactDetails) as ArtifactKind[]).map((kind) => {
              const Icon = artifactDetails[kind].icon;
              return <button key={kind} className={rightView === kind ? "active" : ""} onClick={() => setRightView(kind)}><Icon size={17} /> {artifactDetails[kind].title}</button>;
            })}
          </nav>
          <div className="sidebar-divider" />
          <details className="chapter-index" open>
            <summary><BookOpen size={14} /> 章节目录 <b>{(paper.outline ?? []).length}</b></summary>
            <div className="chapter-index-list">
              {(paper.outline ?? []).length ? paper.outline!.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={activeSectionId === section.id ? "active" : ""}
                  style={{ "--chapter-level": Math.min(5, Math.max(0, section.level - 1)) } as CSSProperties}
                  title={section.title}
                  onClick={() => setChapterScrollRequest((current) => ({
                    page: section.page,
                    nonce: (current?.nonce ?? 0) + 1,
                  }))}
                >
                  <span className="chapter-title">{section.title}</span>
                  <span className="chapter-page">p.{section.page}</span>
                </button>
              )) : <p className="sidebar-empty">未识别到章节标题。</p>}
            </div>
          </details>
          <SidebarQuote />
          <div className="privacy-note"><CheckCircle2 size={15} /> PDF 和成果已开启本机磁盘自动备份</div>
        </aside>
        <PdfReader
          paper={paper}
          activeAnchors={activeAnchors}
          highlightRegions={highlightRegions}
          conversations={workspace.conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={selectConversation}
          outline={paper.outline ?? []}
          requestedChapterPage={chapterScrollRequest}
          conversationFocusRequest={conversationFocusRequest}
          onSelectAnchor={selectAnchor}
          onClearSelection={clearActiveSelection}
          onActiveSectionChange={onActiveSectionChange}
          leftCollapsed={leftCollapsed}
          rightCollapsed={rightCollapsed}
          onRestoreLeft={() => setLeftCollapsed(false)}
          onRestoreRight={() => setRightCollapsed(false)}
        />
        <aside className={`assistant-panel ${rightCollapsed ? "collapsed" : ""}`}>
          <div className="assistant-topbar">
            <ModelSwitch mode={mode} setMode={setMode} />
            <button className="panel-collapse" onClick={() => setRightCollapsed(true)} aria-label="折叠右侧" title="折叠右侧"><PanelRightClose size={15} /></button>
          </div>
          {rightView === "chat" ? (
            <ChatPanel
              anchors={activeAnchors}
              selectionGroup={activeSelection}
              conversation={selectedConversation}
              conversations={workspace.conversations}
              activeConversationId={activeConversationId}
              question={question}
              setQuestion={setQuestion}
              generating={generating}
              pendingColor={pendingColor}
              onPendingColorChange={setPendingColor}
              onChangeColor={changeConversationColor}
              onPrompt={(kind) => void sendQuestion(kind)}
              onSelectConversation={selectConversation}
            />
          ) : (
            <ArtifactPanel
              kind={rightView}
              paper={paper}
              artifact={artifact}
              generating={generating}
              onGenerate={() => void generateArtifact(rightView)}
              onEdit={(content) => editArtifact(rightView, content)}
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
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiKey={apiKey}
        setApiKey={setApiKey}
        state={keyState}
        onTest={() => void testKey()}
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
      />
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "compact" : ""}`}><span className="brand-mark"><BrainCircuit size={compact ? 18 : 21} /></span><span><strong>Paper<span>mate</span></strong>{!compact && <small>论文阅读辅助助手</small>}</span></div>;
}

function SidebarQuote() {
  const [quoteIndex, setQuoteIndex] = useState(0);

  const pickNext = useCallback(() => {
    setQuoteIndex((current) => {
      if (READER_QUOTES.length <= 1) return 0;
      let next = Math.floor(Math.random() * READER_QUOTES.length);
      if (next === current) {
        next = (next + 1 + Math.floor(Math.random() * (READER_QUOTES.length - 1))) % READER_QUOTES.length;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    pickNext();
    const timer = window.setInterval(pickNext, 45000);
    return () => window.clearInterval(timer);
  }, [pickNext]);

  const quote = READER_QUOTES[quoteIndex] ?? "";
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

function ModelSwitch({ mode, setMode }: { mode: ModelMode; setMode: (mode: ModelMode) => void }) {
  return <div className="model-switch" role="group" aria-label="回答模式">
    <button className={mode === "fast" ? "active" : ""} onClick={() => setMode("fast")}><span>快速</span><small>Flash</small></button>
    <button className={mode === "deep" ? "active" : ""} onClick={() => setMode("deep")}><span>深度</span><small>MAX 思考</small></button>
  </div>;
}

function ChatPanel({ anchors, selectionGroup, conversation, conversations, activeConversationId, question, setQuestion, generating, pendingColor, onPendingColorChange, onChangeColor, onPrompt, onSelectConversation }: {
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
  onPrompt: (kind: PromptKind) => void;
  onSelectConversation: (conversation: Conversation) => void;
}) {
  const historyRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ turnId: string; nonce: number }>();
  const [selectionExpanded, setSelectionExpanded] = useState(false);

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
    <div className="panel-heading"><span className="panel-icon"><Bot size={17} /></span><div><h2>和论文聊一聊</h2><p>{selectionAnchors.length ? `当前选区 · ${selectionAnchors.length} 个片段` : "可自由提问，划选原文后会自动带上上下文"}</p></div></div>
    <details className="question-index">
      <summary><MessageCircleMore size={14} /> 提问索引 <b>{indexItems.length}</b></summary>
      {indexItems.length ? (
        <div className="question-index-list">
          {indexItems.map((item) => (
            <button
              key={item.turn.id}
              className={`question-index-item ${item.conversation.id === activeConversationId ? "active" : ""}`}
              onClick={() => jumpToIndex(item)}
            >
              <span className="page">
                {item.turn.selection?.anchors.length
                  ? `p.${[...new Set(item.turn.selection.anchors.map((entry) => entry.page))].join("/")}`
                  : `p.${item.conversation.anchor?.page ?? "全"}`}
              </span>
              <p>{item.turn.content}</p>
              <time>{readableDate(item.turn.createdAt)}</time>
            </button>
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
    <div className="quick-prompts">
      <button disabled={generating} onClick={() => onPrompt("translate")}>翻译</button>
      <button disabled={generating} onClick={() => onPrompt("context")}>结合上下文解释</button>
      <button disabled={generating} onClick={() => onPrompt("concept")}>详细讲解</button>
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
          {turn.role === "assistant" && turn.selection?.anchors.length ? (
            <small>依据第 {[...new Set(turn.selection.anchors.map((entry) => entry.page))].join("、")} 页共 {turn.selection.anchors.length} 个片段</small>
          ) : turn.anchor && turn.role === "assistant" ? (
            <small>依据第 {turn.anchor.page} 页选段</small>
          ) : null}
        </div>
      )) : <div className="chat-empty"><CircleHelp size={22} /><p>选中一句话，或提出关于整篇论文的问题。</p></div>}
    </div>
    <div className="question-box"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="输入你的问题…" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onPrompt("free"); }} /><button disabled={generating || !question.trim()} aria-label="发送问题" onClick={() => onPrompt("free")}><SendHorizonal size={17} /></button></div>
    <p className="input-hint">⌘ / Ctrl + Enter 发送 · 回答优先依据论文原文</p>
  </div>;
}

function ArtifactPanel({ kind, paper, artifact, generating, onGenerate, onEdit }: {
  kind: ArtifactKind;
  paper: Paper;
  artifact?: GeneratedArtifact;
  generating: boolean;
  onGenerate: () => void;
  onEdit: (content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const lastArtifactId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (artifact?.id && artifact.id !== lastArtifactId.current) {
      lastArtifactId.current = artifact.id;
      setEditing(false);
    }
  }, [artifact?.id]);
  const details = artifactDetails[kind];
  const Icon = details.icon;
  const svg = kind === "mindmap" && artifact?.content ? mindMapToSvg(markdownToMindMap(artifact.content, paper.title)) : undefined;
  const download = () => {
    if (!artifact) return;
    const base = `${paper.title}-${details.title}`.replace(/[\\/:*?"<>|]/g, "-");
    if (kind === "mindmap" && svg) downloadFile(`${base}.svg`, svg, "image/svg+xml");
    else downloadFile(`${base}.md`, artifact.content, "text/markdown;charset=utf-8");
  };
  return <div className="artifact-panel">
    <div className="panel-heading"><span className="panel-icon"><Icon size={17} /></span><div><h2>{details.title}</h2><p>{details.description}</p></div></div>
    {!artifact?.content && !generating ? <div className="artifact-empty"><Icon size={28} /><h3>从这篇论文开始提炼</h3><p>将使用全文文本进行深度分析，生成结果只保存在此浏览器。</p><button className="primary-action" onClick={onGenerate}><Sparkles size={16} /> 生成{details.title}</button></div> : <>
      <div className="artifact-actions">
        <button disabled={generating} onClick={onGenerate}>{generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{generating ? "正在分析" : "重新生成"}</button>
        <button disabled={!artifact?.content} onClick={download}><Download size={15} /> 保存本地</button>
        {artifact?.content ? <button disabled={generating} onClick={() => setEditing((value) => !value)}>{editing ? "完成编辑" : "编辑文本"}</button> : null}
      </div>
      {kind === "mindmap" && svg && <div className="mindmap-preview" dangerouslySetInnerHTML={{ __html: svg }} />}
      {editing ? (
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

function SettingsSheet({ open, onClose, apiKey, setApiKey, state, onTest, theme, onThemeChange, backupState, backupSavedAt, backupFilePath, onBackupNow, onRestoreBackup, onExportBackup, onImportBackup, onCopyPath }: {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  state: "idle" | "testing" | "valid" | "invalid";
  onTest: () => void;
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
}) {
  const backupFileInputRef = useRef<HTMLInputElement>(null);

  async function copyBackupPath() {
    try {
      await copyTextToClipboard(backupFilePath);
      onCopyPath(true);
    } catch {
      onCopyPath(false);
    }
  }

  if (!open) return null;
  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="模型与主题设置">
      <div className="settings-sheet">
        <button className="close-sheet" onClick={onClose} aria-label="关闭设置"><X size={18} /></button>
        <span className="settings-kicker">DEEPSEEK CONFIGURATION</span>
        <h2>连接你的模型</h2>
        <p>填写自己的 DeepSeek API Key。它只留在当前页面内存，每次调用后由代理立即丢弃，不会写入本地论文库。</p>
        <label>DeepSeek API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" /></label>
        <button className="test-key" disabled={!apiKey.trim() || state === "testing"} onClick={onTest}>{state === "testing" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}{state === "testing" ? "验证中" : "验证连接"}</button>
        {state === "valid" && <p className="key-result good">连接成功，可以开始提问。</p>}
        {state === "invalid" && <p className="key-result bad">连接失败，请检查 Key、额度或网络。</p>}
        <div className="settings-theme-section">
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
        </div>
        <div className="settings-backup-section">
          <span className="settings-kicker">LOCAL BACKUP</span>
          <h3>本机磁盘备份</h3>
          <p className={`backup-status ${backupState === "error" ? "error" : ""}`}>
            {backupState === "saving"
              ? "正在写入本机磁盘…"
              : backupState === "restoring"
                ? "正在从备份恢复…"
                : backupState === "error"
                  ? "备份失败，请检查磁盘"
                  : backupSavedAt
                    ? `已自动备份 · ${readableDateTime(backupSavedAt)}`
                    : "自动备份已开启"}
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
        </div>
        <div className="mode-info"><div><b>快速 · Flash</b><span>翻译、基础问答</span></div><div><b>深度 · MAX 思考</b><span>解释、总结、写作分析</span></div></div>
      </div>
    </div>
  );
}
