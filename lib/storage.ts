import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isBackup,
  type BackupPaper,
  type BackupSettings,
  type BackupWorkspace,
  type PaperMateBackup,
} from "./backup";
import type { PaperMeta, PaperWorkspace } from "./types";

// node:sqlite is not in Vite's builtin list, so loading it via an import trips
// up Vitest's vite-node resolver. process.getBuiltinModule avoids that path.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

interface PaperRow {
  id: string;
  title: string;
  file_name: string;
  source_hash: string | null;
  keywords: string | null;
  journal_name: string | null;
  impact_factor: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  page_count: number;
  original_ready: number;
  pdf: Uint8Array | null;
  parsed_json: string;
}

interface WorkspaceRow {
  paper_id: string;
  data_json: string;
}

interface SettingsRow {
  key: string;
  value: string;
}

export interface PaperMateStorage {
  listPaperMetas(): PaperMeta[];
  getPaper(id: string): BackupPaper | undefined;
  savePaper(paper: BackupPaper): void;
  findPaperBySourceHash(hash: string): BackupPaper | undefined;
  updatePaperNote(id: string, note: string): void;
  deletePaper(id: string): void;
  getWorkspace(paperId: string): PaperWorkspace;
  saveWorkspace(paperId: string, workspace: PaperWorkspace): void;
  listWorkspaces(): BackupWorkspace[];
  getSettings(): BackupSettings;
  saveSettings(settings: BackupSettings): void;
  buildBackup(): PaperMateBackup;
  importBackup(backup: PaperMateBackup): { papers: number; workspaces: number };
  migrateFromJsonIfEmpty(): boolean;
  close(): void;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseKeywords(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      const keywords = parsed.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      );
      return keywords.length ? keywords : undefined;
    }
  } catch {
    // 损坏的关键词数据按缺失处理
  }
  return undefined;
}

function paperToRow(paper: BackupPaper): {
  buffer: Buffer;
  hash: string | null;
  parsed: string;
  values: Array<string | number | Uint8Array | null>;
} {
  const buffer = Buffer.from(paper.file?.base64 ?? "", "base64");
  const computedHash = paper.sourceHash?.trim() || sha256Bytes(buffer);
  const hash = buffer.length > 0 && computedHash ? computedHash : null;
  const parsed = JSON.stringify({
    pages: paper.pages ?? [],
    outline: paper.outline,
  });
  const keywords = paper.keywords?.length ? JSON.stringify(paper.keywords) : null;
  return {
    buffer,
    hash,
    parsed,
    values: [
      paper.id,
      paper.title,
      paper.fileName,
      hash,
      keywords,
      paper.journal ?? null,
      paper.impactFactor ?? null,
      paper.note ?? null,
      paper.createdAt,
      paper.updatedAt,
      paper.pageCount,
      paper.originalReady ? 1 : 0,
      buffer,
      parsed,
    ],
  };
}

function rowToBackupPaper(row: PaperRow): BackupPaper {
  const parsed = JSON.parse(row.parsed_json || "{}") as {
    pages?: BackupPaper["pages"];
    outline?: BackupPaper["outline"];
  };
  const pdf = row.pdf ? Buffer.from(row.pdf) : Buffer.alloc(0);
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    sourceHash: row.source_hash ?? undefined,
    keywords: parseKeywords(row.keywords),
    journal: row.journal_name ?? undefined,
    impactFactor: row.impact_factor ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pages: parsed.pages ?? [],
    pageCount: row.page_count,
    outline: parsed.outline,
    originalReady: Boolean(row.original_ready),
    file: {
      name: row.file_name,
      type: "application/pdf",
      size: pdf.length,
      base64: pdf.toString("base64"),
    },
  };
}

function rowToWorkspace(row: WorkspaceRow): BackupWorkspace {
  const parsed = JSON.parse(row.data_json || "{}") as PaperWorkspace;
  return {
    paperId: row.paper_id,
    annotations: parsed.annotations ?? [],
    conversations: parsed.conversations ?? [],
    artifacts: parsed.artifacts ?? [],
  };
}

export function openStorage(options: {
  dbPath?: string;
  backupPath?: string;
} = {}): PaperMateStorage {
  const dbPath = options.dbPath ?? path.join(process.cwd(), "data", "papermate.db");
  const backupPath =
    options.backupPath ?? path.join(process.cwd(), "data", "papermate-backup.json");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_hash TEXT UNIQUE,
      keywords TEXT,
      journal_name TEXT,
      impact_factor TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      original_ready INTEGER NOT NULL DEFAULT 0,
      pdf BLOB,
      parsed_json TEXT NOT NULL
    );
  `);
  const existingPaperColumns = new Set(
    (db.prepare("PRAGMA table_info(papers)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!existingPaperColumns.has("keywords")) {
    db.exec("ALTER TABLE papers ADD COLUMN keywords TEXT");
  }
  if (!existingPaperColumns.has("journal_name")) {
    db.exec("ALTER TABLE papers ADD COLUMN journal_name TEXT");
  }
  if (!existingPaperColumns.has("impact_factor")) {
    db.exec("ALTER TABLE papers ADD COLUMN impact_factor TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      paper_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertPaperStatement = db.prepare(`
    INSERT INTO papers (
      id, title, file_name, source_hash, keywords, journal_name, impact_factor,
      note, created_at, updated_at, page_count, original_ready, pdf, parsed_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      file_name = excluded.file_name,
      source_hash = excluded.source_hash,
      keywords = excluded.keywords,
      journal_name = excluded.journal_name,
      impact_factor = excluded.impact_factor,
      note = excluded.note,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      page_count = excluded.page_count,
      original_ready = excluded.original_ready,
      pdf = excluded.pdf,
      parsed_json = excluded.parsed_json
  `);
  const selectPaperById = db.prepare("SELECT * FROM papers WHERE id = ?");
  const selectPaperByHash = db.prepare("SELECT * FROM papers WHERE source_hash = ?");
  const selectPapersWithMissingHash = db.prepare(
    "SELECT * FROM papers WHERE source_hash IS NULL OR source_hash = ''",
  );
  const updatePaperHash = db.prepare(
    "UPDATE papers SET source_hash = ?, updated_at = ? WHERE id = ?",
  );
  const updatePaperNote = db.prepare("UPDATE papers SET note = ? WHERE id = ?");
  const deleteWorkspace = db.prepare("DELETE FROM workspaces WHERE paper_id = ?");
  const deletePaper = db.prepare("DELETE FROM papers WHERE id = ?");
  const selectWorkspace = db.prepare("SELECT * FROM workspaces WHERE paper_id = ?");
  const selectAllWorkspaces = db.prepare("SELECT * FROM workspaces");
  const upsertWorkspace = db.prepare(`
    INSERT INTO workspaces (paper_id, data_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `);
  const selectSettings = db.prepare("SELECT key, value FROM settings");
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  function savePaperRow(paper: BackupPaper) {
    const { hash, values } = paperToRow(paper);
    if (hash) {
      const existing = selectPaperByHash.get(hash) as unknown as PaperRow | undefined;
      if (existing && existing.id !== paper.id) {
        throw new Error("已有同源论文，无法重复保存。");
      }
    }
    insertPaperStatement.run(...values);
  }

  return {
    listPaperMetas() {
      const rows = db
        .prepare("SELECT id, title, file_name, source_hash, keywords, journal_name, impact_factor, note, created_at, updated_at, page_count, original_ready FROM papers ORDER BY updated_at DESC")
        .all() as Array<Omit<PaperRow, "pdf" | "parsed_json">>;
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        fileName: row.file_name,
        sourceHash: row.source_hash ?? undefined,
        keywords: parseKeywords(row.keywords),
        journal: row.journal_name ?? undefined,
        impactFactor: row.impact_factor ?? undefined,
        note: row.note ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        pageCount: row.page_count,
        originalReady: Boolean(row.original_ready),
      }));
    },

    getPaper(id) {
      const row = selectPaperById.get(id) as unknown as PaperRow | undefined;
      return row ? rowToBackupPaper(row) : undefined;
    },

    savePaper(paper) {
      savePaperRow(paper);
    },

    findPaperBySourceHash(hash) {
      const normalized = hash.trim();
      if (!normalized) return undefined;
      const row = selectPaperByHash.get(normalized) as unknown as PaperRow | undefined;
      if (row) return rowToBackupPaper(row);
      const rows = selectPapersWithMissingHash.all() as unknown as PaperRow[];
      for (const missing of rows) {
        if (!missing.pdf) continue;
        const computed = sha256Bytes(missing.pdf);
        if (computed === normalized) {
          const updatedAt = new Date().toISOString();
          updatePaperHash.run(normalized, updatedAt, missing.id);
          return rowToBackupPaper({ ...missing, source_hash: normalized });
        }
      }
      return undefined;
    },

    updatePaperNote(id, note) {
      updatePaperNote.run(note, id);
    },

    deletePaper(id) {
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteWorkspace.run(id);
        deletePaper.run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getWorkspace(paperId) {
      const row = selectWorkspace.get(paperId) as unknown as WorkspaceRow | undefined;
      if (!row) return { annotations: [], conversations: [], artifacts: [] };
      const parsed = JSON.parse(row.data_json || "{}") as PaperWorkspace;
      return {
        annotations: parsed.annotations ?? [],
        conversations: parsed.conversations ?? [],
        artifacts: parsed.artifacts ?? [],
      };
    },

    saveWorkspace(paperId, workspace) {
      upsertWorkspace.run(
        paperId,
        JSON.stringify({
          annotations: workspace.annotations ?? [],
          conversations: workspace.conversations ?? [],
          artifacts: workspace.artifacts ?? [],
        }),
        new Date().toISOString(),
      );
    },

    listWorkspaces() {
      return (selectAllWorkspaces.all() as unknown as WorkspaceRow[]).map(rowToWorkspace);
    },

    getSettings() {
      const rows = selectSettings.all() as unknown as SettingsRow[];
      const settings: BackupSettings = {};
      for (const row of rows) {
        if (row.key === "theme") settings.theme = row.value;
        if (row.key === "layout") {
          try {
            settings.layout = JSON.parse(row.value) as BackupSettings["layout"];
          } catch {
            // 布局设置损坏时忽略
          }
        }
      }
      return settings;
    },

    saveSettings(settings) {
      if (settings.theme) upsertSetting.run("theme", settings.theme);
      if (settings.layout) upsertSetting.run("layout", JSON.stringify(settings.layout));
    },

    buildBackup() {
      const paperRows = db.prepare("SELECT * FROM papers ORDER BY updated_at DESC").all() as unknown as PaperRow[];
      const workspaces = this.listWorkspaces();
      const settings = this.getSettings();
      const backup: PaperMateBackup = {
        version: 1,
        savedAt: new Date().toISOString(),
        papers: paperRows.map(rowToBackupPaper),
        workspaces,
      };
      if (settings.theme || settings.layout) backup.settings = settings;
      return backup;
    },

    importBackup(backup) {
      if (!isBackup(backup)) throw new Error("备份格式无效。");
      const seenHashes = new Set<string>();
      for (const paper of backup.papers) {
        const { hash } = paperToRow(paper);
        if (hash) {
          if (seenHashes.has(hash)) {
            throw new Error("备份中存在重复论文，无法导入。");
          }
          seenHashes.add(hash);
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM workspaces");
        db.exec("DELETE FROM papers");
        for (const paper of backup.papers) savePaperRow(paper);
        for (const workspace of backup.workspaces) {
          if (!selectPaperById.get(workspace.paperId)) continue;
          upsertWorkspace.run(
            workspace.paperId,
            JSON.stringify({
              annotations: workspace.annotations ?? [],
              conversations: workspace.conversations ?? [],
              artifacts: workspace.artifacts ?? [],
            }),
            new Date().toISOString(),
          );
        }
        this.saveSettings(backup.settings ?? {});
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return {
        papers: backup.papers.length,
        workspaces: backup.workspaces.length,
      };
    },

    migrateFromJsonIfEmpty() {
      const count = (db.prepare("SELECT COUNT(*) AS count FROM papers").get() as { count: number })
        .count;
      if (count > 0) return false;
      if (!existsSync(backupPath)) return false;
      try {
        const parsed = JSON.parse(readFileSync(backupPath, "utf8")) as unknown;
        if (!isBackup(parsed)) return false;
        this.importBackup(parsed);
        return true;
      } catch {
        return false;
      }
    },

    close() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // 数据库仍可正常关闭；WAL 会在下次打开时自动恢复
      }
      db.close();
    },
  };
}

let defaultStorage: PaperMateStorage | undefined;

export function getDefaultStorage(): PaperMateStorage {
  if (!defaultStorage) {
    defaultStorage = openStorage();
    defaultStorage.migrateFromJsonIfEmpty();
  }
  return defaultStorage;
}

export function writeBackupFile(backup: PaperMateBackup, backupPath: string): void {
  mkdirSync(path.dirname(backupPath), { recursive: true });
  const tempFile = `${backupPath}.${Date.now()}.tmp`;
  writeFileSync(tempFile, JSON.stringify(backup, null, 2), "utf8");
  try {
    renameSync(tempFile, backupPath);
  } catch {
    rmSync(backupPath, { force: true });
    renameSync(tempFile, backupPath);
  }
}
