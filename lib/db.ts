import {
  backupToPaper,
  buildBackup,
  paperToBackup,
  type BackupPaper,
  type BackupSettings,
  type BackupWorkspace,
  type PaperMateBackup,
} from "@/lib/backup";
import type { Paper, PaperMeta, PaperWorkspace } from "@/lib/types";
import type {
  PaperMetadataLookupInput,
  PaperMetadataPatch,
} from "@/lib/paper-metadata";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `请求失败（${response.status}）。`);
  }
  return (await response.json()) as T;
}

export async function listPapers(): Promise<PaperMeta[]> {
  const data = await requestJson<{ papers: PaperMeta[] }>("/api/storage/papers");
  return data.papers;
}

export async function listWorkspaces(): Promise<BackupWorkspace[]> {
  const backup = await requestJson<PaperMateBackup>("/api/storage/export");
  return backup.workspaces;
}

export async function replaceAll(
  papers: Paper[],
  workspaces: BackupWorkspace[],
): Promise<void> {
  const backup = await buildBackup(papers, workspaces);
  await importBackup(backup);
}

export async function getPaper(id: string): Promise<Paper | undefined> {
  const data = await requestJson<{ paper: BackupPaper | null }>(
    `/api/storage/papers/${encodeURIComponent(id)}`,
  );
  return data.paper ? backupToPaper(data.paper) : undefined;
}

export async function savePaper(paper: Paper): Promise<void> {
  const payload = await paperToBackup(paper);
  await requestJson<{ ok: true }>("/api/storage/papers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function findPaperBySourceHash(
  sourceHash: string,
): Promise<Paper | undefined> {
  const data = await requestJson<{ paper: BackupPaper | null }>(
    `/api/storage/papers/by-hash/${encodeURIComponent(sourceHash)}`,
  );
  return data.paper ? backupToPaper(data.paper) : undefined;
}

export async function updatePaperNote(id: string, note: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/storage/papers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ note }),
  });
}

export async function deletePaper(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/storage/papers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getWorkspace(paperId: string): Promise<PaperWorkspace> {
  const data = await requestJson<{ workspace: PaperWorkspace }>(
    `/api/storage/workspaces/${encodeURIComponent(paperId)}`,
  );
  return data.workspace;
}

export async function saveWorkspace(
  paperId: string,
  workspace: PaperWorkspace,
): Promise<void> {
  await requestJson<{ ok: true }>(
    `/api/storage/workspaces/${encodeURIComponent(paperId)}`,
    {
      method: "PUT",
      body: JSON.stringify(workspace),
    },
  );
}

export async function exportBackup(): Promise<PaperMateBackup> {
  return requestJson<PaperMateBackup>("/api/storage/export");
}

export async function importBackup(backup: PaperMateBackup): Promise<void> {
  await requestJson<{ ok: true }>("/api/storage/import", {
    method: "POST",
    body: JSON.stringify(backup),
  });
}

export async function getSettings(): Promise<BackupSettings> {
  const data = await requestJson<{ settings: BackupSettings }>("/api/storage/settings");
  return data.settings;
}

export async function saveSettings(settings: BackupSettings): Promise<void> {
  await requestJson<{ ok: true }>("/api/storage/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function lookupPaperMetadata(
  input: PaperMetadataLookupInput,
): Promise<PaperMetadataPatch> {
  return requestJson<PaperMetadataPatch>("/api/storage/metadata", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface DiskBackupInfo {
  filePath: string;
  savedAt?: string;
  paperCount: number;
  workspaceCount: number;
  backup?: PaperMateBackup;
}

export async function fetchDiskBackup(full = false): Promise<DiskBackupInfo> {
  const response = await fetch(
    `/api/storage/backup${full ? "?full=1" : ""}`,
    { cache: "no-store" },
  );
  const data = (await response.json()) as Partial<PaperMateBackup> & {
    filePath?: string;
    ok?: boolean;
    paperCount?: number;
    workspaceCount?: number;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(data.error ?? "无法读取本机备份。");
  }
  return {
    filePath: data.filePath ?? "data/papermate-backup.json",
    savedAt: data.savedAt,
    paperCount: data.paperCount ?? data.papers?.length ?? 0,
    workspaceCount: data.workspaceCount ?? data.workspaces?.length ?? 0,
    backup: full
      ? {
          version: 1,
          savedAt: data.savedAt ?? "",
          papers: data.papers ?? [],
          workspaces: data.workspaces ?? [],
          ...(data.settings ? { settings: data.settings } : {}),
        }
      : undefined,
  };
}

export async function writeDiskBackup(): Promise<{
  savedAt: string;
  filePath: string;
}> {
  return requestJson<{ savedAt: string; filePath: string }>("/api/storage/backup", {
    method: "POST",
  });
}
