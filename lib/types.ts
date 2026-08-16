export type ModelMode = "fast" | "deep";
export type PromptKind = "translate" | "context" | "concept" | "free";
export type ArtifactKind = "notes" | "mindmap" | "writing";
export type PaperSectionSource = "outline" | "inferred";

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

export interface FigureAsset {
  id: string;
  page: number;
  top: number;
  dataUrl: string;
  width: number;
  height: number;
  label?: string;
  caption?: string;
}

export interface ParsedPage {
  page: number;
  text: string;
  blocks: ParagraphBlock[];
  figures: FigureAsset[];
  width?: number;
  height?: number;
  rotation?: number;
  textItems?: PdfTextItem[];
}

export interface Paper {
  id: string;
  title: string;
  fileName: string;
  file: Blob;
  sourceHash?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  pages: ParsedPage[];
  pageCount: number;
  outline?: PaperSection[];
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
  kind?: PromptKind;
  anchor?: TextAnchor;
  selection?: SelectionGroup;
}

export interface Conversation {
  id: string;
  paperId: string;
  anchor?: TextAnchor;
  selection?: SelectionGroup;
  title: string;
  color?: HighlightColor;
  turns: ChatTurn[];
  updatedAt: string;
}

export interface GeneratedArtifact {
  id: string;
  paperId: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperWorkspace {
  annotations: Annotation[];
  conversations: Conversation[];
  artifacts: GeneratedArtifact[];
}
