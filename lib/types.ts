import type { WebSearchSource } from "./web-search";

export type ModelMode = "fast" | "deep";
export type ModelProvider = "deepseek" | "glm" | "kimi" | "custom";
export type PromptKind = "translate" | "context" | "concept" | "free";
export type ArtifactKind = "notes" | "mindmap" | "writing";
type ConversationScope = "normal" | "context";
type PaperSectionSource = "outline" | "inferred";

export interface TextAnchor {
  id: string;
  page: number;
  start: number;
  end: number;
  quote: string;
  hash: string;
  section?: string;
  blockIds?: string[];
  textItemStart?: number;
  textItemEnd?: number;
  textStartOffset?: number;
  textEndOffset?: number;
}

export interface SelectionGroup {
  id: string;
  paperId: string;
  anchors: TextAnchor[];
}

export interface ParagraphBlock {
  id: string;
  page: number;
  index: number;
  text: string;
  start: number;
  end: number;
  top: number;
  kind?: "heading" | "paragraph" | "caption" | "table" | "equation";
  label?: string;
  figureId?: string;
  fontSize?: number;
  cells?: string[][];
}

export interface PaperSection {
  id: string;
  title: string;
  page: number;
  level: number;
  source: PaperSectionSource;
}

export interface PdfTextItem {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  hasEOL: boolean;
  blockId?: string;
}

interface FigureAsset {
  id: string;
  page: number;
  top: number;
  dataUrl: string;
  width: number;
  height: number;
  label?: string;
  caption?: string;
}

export interface CitationTarget {
  page: number;
  top: number;
}

/** PDF 原生 Link 注解：矩形（视口坐标，缩放无关，相对页面左上角）+ 目标页/URL。 */
export interface PdfLinkAnnotation {
  /** 页面内矩形 [left, top, right, bottom]（PDF 单位，scale=1 视口坐标，top 向下）。 */
  rect: [number, number, number, number];
  /** 内部目标页码（1-based）；外部链接时为空。 */
  targetPage?: number;
  /** 目标在目标页内的纵向位置（scale=1 视口坐标，相对页面顶部，向下为正）；未知时为空。 */
  targetTop?: number;
  /** 外部 URL（http/https）；内部链接时为空。 */
  url?: string;
}

export interface ParsedPage {
  page: number;
  text: string;
  blocks: ParagraphBlock[];
  figures: FigureAsset[];
  links?: PdfLinkAnnotation[];
  width?: number;
  height?: number;
  rotation?: number;
  textItems?: PdfTextItem[];
}

export interface Paper {
  lastReadAt?: string;
  id: string;
  title: string;
  fileName: string;
  file: Blob;
  sourceHash?: string;
  note?: string;
  keywords?: string[];
  journal?: string;
  impactFactor?: string;
  /** 论文库中是否置顶（置顶的论文始终排在本地论文库最前）。 */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  pages: ParsedPage[];
  pageCount: number;
  outline?: PaperSection[];
  originalReady?: boolean;
  /**
   * 补齐台账：上次尝试补排版数据（links/textItems）的时间与连续失败次数。
   * 用来做失败后的冷却重试，避免"补不上就每次打开都重解析整本 PDF"。
   */
  linksCheckedAt?: string;
  linksAttempts?: number;
  /** 补齐台账：上次查询元数据（标题/期刊/影响因子/关键词）的时间与连续失败次数。 */
  metadataCheckedAt?: string;
  metadataAttempts?: number;
}

export interface PaperMeta {
  lastReadAt?: string;
  id: string;
  title: string;
  fileName: string;
  sourceHash?: string;
  note?: string;
  keywords?: string[];
  journal?: string;
  impactFactor?: string;
  /** 论文库中是否置顶。 */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
  pageCount: number;
  originalReady?: boolean;
}

export interface Annotation {
  id: string;
  paperId: string;
  anchor: TextAnchor;
  createdAt: string;
}

export type HighlightColor =
  | "sage"
  | "sky"
  | "peach"
  | "rose"
  | "lilac"
  | "butter";

export interface HighlightRegion {
  id: string;
  paperId: string;
  anchor: TextAnchor;
  conversationIds: string[];
  color: HighlightColor;
  updatedAt: string;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  mode?: ModelMode;
  provider?: ModelProvider;
  kind?: PromptKind;
  anchor?: TextAnchor;
  selection?: SelectionGroup;
  /** 本次回答实际使用的联网来源（仅在联网检索成功时写入；老记录没有该字段）。 */
  sources?: WebSearchSource[];
}

export interface Conversation {
  id: string;
  paperId: string;
  anchor?: TextAnchor;
  selection?: SelectionGroup;
  scope?: ConversationScope;
  title: string;
  color?: HighlightColor;
  turns: ChatTurn[];
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  content: string;
  createdAt: string;
}

export interface GeneratedArtifact {
  id: string;
  paperId: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** 之前生成的版本（最新在前）；重新生成成功后自动保存，也可手动保存。 */
  versions?: ArtifactVersion[];
}

export interface PaperWorkspace {
  annotations: Annotation[];
  conversations: Conversation[];
  artifacts: GeneratedArtifact[];
}
