import type { Paper, PaperWorkspace } from "@/lib/types";

export interface BackupFileRecord {
  name: string;
  type: string;
  size: number;
  base64: string;
}

export type BackupPaper = Omit<Paper, "file"> & {
  file: BackupFileRecord;
};

export interface BackupWorkspace extends PaperWorkspace {
  paperId: string;
}

export interface BackupSettings {
  theme?: string;
  layout?: {
    leftWidth?: number;
    rightWidth?: number;
    leftCollapsed?: boolean;
    rightCollapsed?: boolean;
  };
}

export interface PaperMateBackup {
  version: 1;
  savedAt: string;
  papers: BackupPaper[];
  workspaces: BackupWorkspace[];
  settings?: BackupSettings;
}

export const BACKUP_VERSION = 1 as const;

export function isBackup(value: unknown): value is PaperMateBackup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PaperMateBackup>;
  return (
    candidate.version === BACKUP_VERSION &&
    Array.isArray(candidate.papers) &&
    Array.isArray(candidate.workspaces) &&
    (typeof candidate.savedAt === "string" || candidate.savedAt === undefined) &&
    (candidate.settings === undefined || typeof candidate.settings === "object")
  );
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

export async function paperToBackup(paper: Paper): Promise<BackupPaper> {
  const { file, ...metadata } = paper;
  return {
    ...metadata,
    file: {
      name: paper.fileName,
      type: file.type || "application/pdf",
      size: file.size,
      base64: await blobToBase64(file),
    },
  };
}

export function backupToPaper(record: BackupPaper): Paper {
  const { file, ...metadata } = record;
  const blob = base64ToBlob(file.base64, file.type);
  return {
    ...metadata,
    file: new File([blob], file.name, { type: file.type }),
  };
}

export async function buildBackup(
  papers: Paper[],
  workspaces: BackupWorkspace[],
  settings?: BackupSettings,
): Promise<PaperMateBackup> {
  return {
    version: BACKUP_VERSION,
    savedAt: new Date().toISOString(),
    papers: await Promise.all(papers.map((paper) => paperToBackup(paper))),
    workspaces,
    ...(settings ? { settings } : {}),
  };
}

export function emptyBackup(): PaperMateBackup {
  return {
    version: BACKUP_VERSION,
    savedAt: "",
    papers: [],
    workspaces: [],
  };
}
