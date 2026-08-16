import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupPaper, BackupWorkspace, PaperMateBackup } from "./backup";
import { openStorage, type PaperMateStorage } from "./storage";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "papermate-storage-"));
  tempDirs.push(dir);
  return dir;
}

function makePaper(
  id: string,
  sourceHash: string,
  title = id,
  extra: Partial<BackupPaper> = {},
): BackupPaper {
  return {
    id,
    title,
    fileName: `${title}.pdf`,
    sourceHash,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    pageCount: 1,
    pages: [],
    originalReady: false,
    file: {
      name: `${title}.pdf`,
      type: "application/pdf",
      size: 3,
      base64: Buffer.from("pdf").toString("base64"),
    },
    ...extra,
  };
}

function makeWorkspace(paperId: string): BackupWorkspace {
  return {
    paperId,
    annotations: [],
    conversations: [
      {
        id: `conversation-${paperId}`,
        paperId,
        title: "测试问答",
        turns: [
          {
            id: "turn-1",
            role: "user",
            content: "解释第一段",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    artifacts: [],
  };
}

function makeBackup(papers: BackupPaper[], workspaces: BackupWorkspace[]): PaperMateBackup {
  return {
    version: 1,
    savedAt: "2026-01-03T00:00:00.000Z",
    papers,
    workspaces,
  };
}

describe("SQLite paper storage", () => {
  let storage!: PaperMateStorage;

  afterEach(() => {
    storage?.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates tables and starts with an empty library", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    expect(storage.listPaperMetas()).toEqual([]);
    expect(storage.listWorkspaces()).toEqual([]);
    expect(storage.getSettings()).toEqual({});
  });

  it("migrates a v1 JSON backup when the database is empty", () => {
    const dir = tempDir();
    const backupPath = path.join(dir, "papermate-backup.json");
    const paper = makePaper("migrated-paper", "hash-migrated");
    writeFileSync(
      backupPath,
      JSON.stringify(makeBackup([paper], [makeWorkspace(paper.id)]), null, 2),
      "utf8",
    );
    storage = openStorage({ dbPath: path.join(dir, "paper.db"), backupPath });
    expect(storage.migrateFromJsonIfEmpty()).toBe(true);
    expect(storage.listPaperMetas()).toHaveLength(1);
    expect(storage.getPaper(paper.id)?.file.base64).toBe(paper.file.base64);
    expect(storage.getWorkspace(paper.id).conversations).toHaveLength(1);
  });

  it("returns paper metadata without loading PDF blobs or parsed pages", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("meta-paper", "hash-meta", "Meta Paper");
    storage.savePaper(paper);
    const meta = storage.listPaperMetas()[0];
    expect(meta.id).toBe(paper.id);
    expect(meta.title).toBe("Meta Paper");
    expect("file" in meta).toBe(false);
    expect("pages" in meta).toBe(false);
  });

  it("roundtrips keywords, journal, and impact factor", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("meta-paper", "hash-meta", "Meta Paper", {
      keywords: ["NLP", "LLM"],
      journal: "Journal of Testing",
      impactFactor: "12.34",
    });
    storage.savePaper(paper);
    const meta = storage.listPaperMetas()[0];
    expect(meta.title).toBe("Meta Paper");
    expect(meta.keywords).toEqual(["NLP", "LLM"]);
    expect(meta.journal).toBe("Journal of Testing");
    expect(meta.impactFactor).toBe("12.34");
    expect(storage.getPaper(paper.id)?.journal).toBe("Journal of Testing");
    const backup = storage.buildBackup();
    expect(backup.papers[0].keywords).toEqual(["NLP", "LLM"]);
    expect(backup.papers[0].impactFactor).toBe("12.34");
  });

  it("migrates an existing database by adding metadata columns", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "old-paper.db");
    const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const oldDb = new sqlite.DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_hash TEXT UNIQUE,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0,
        original_ready INTEGER NOT NULL DEFAULT 0,
        pdf BLOB,
        parsed_json TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        paper_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    oldDb
      .prepare(
        `INSERT INTO papers (
          id, title, file_name, source_hash, note, created_at, updated_at,
          page_count, original_ready, pdf, parsed_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "old-paper",
        "Old Paper",
        "old.pdf",
        "hash-old",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        1,
        0,
        null,
        "{}",
      );
    oldDb.close();

    storage = openStorage({ dbPath });
    const meta = storage.listPaperMetas()[0];
    expect(meta.id).toBe("old-paper");
    expect(meta.keywords).toBeUndefined();
    expect(meta.journal).toBeUndefined();
    const enriched = makePaper("old-paper", "hash-old", "Old Paper", {
      keywords: ["Legacy"],
      journal: "Legacy Journal",
    });
    storage.savePaper(enriched);
    expect(storage.listPaperMetas()[0].journal).toBe("Legacy Journal");
  });

  it("rejects duplicate source hashes and finds papers by hash", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    storage.savePaper(makePaper("paper-1", "same-hash"));
    expect(() => storage.savePaper(makePaper("paper-2", "same-hash"))).toThrow(/同源论文/);
    expect(storage.findPaperBySourceHash("same-hash")?.id).toBe("paper-1");
    expect(storage.findPaperBySourceHash("missing-hash")).toBeUndefined();
  });

  it("roundtrips workspaces", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("workspace-paper", "hash-workspace");
    const workspace = makeWorkspace(paper.id);
    storage.savePaper(paper);
    storage.saveWorkspace(paper.id, workspace);
    const restored = storage.getWorkspace(paper.id);
    expect(restored.conversations[0].title).toBe("测试问答");
    expect(restored.conversations[0].turns[0].content).toBe("解释第一段");
    expect(storage.listWorkspaces()).toHaveLength(1);
  });

  it("deletes a paper and its workspace together", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("delete-paper", "hash-delete");
    storage.savePaper(paper);
    storage.saveWorkspace(paper.id, makeWorkspace(paper.id));
    storage.deletePaper(paper.id);
    expect(storage.listPaperMetas()).toEqual([]);
    expect(storage.listWorkspaces()).toEqual([]);
  });

  it("replaces the library in a transaction on import", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    storage.savePaper(makePaper("old-paper", "hash-old"));
    storage.saveWorkspace("old-paper", makeWorkspace("old-paper"));

    const nextPaper = makePaper("new-paper", "hash-new", "New Paper");
    const result = storage.importBackup(
      makeBackup([nextPaper], [makeWorkspace(nextPaper.id)]),
    );
    expect(result.papers).toBe(1);
    expect(storage.listPaperMetas().map((meta) => meta.id)).toEqual(["new-paper"]);
    expect(storage.listWorkspaces().map((workspace) => workspace.paperId)).toEqual([
      "new-paper",
    ]);
    expect(storage.getPaper("old-paper")).toBeUndefined();
  });

  it("rolls back an invalid import instead of leaving partial data", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("keep-paper", "hash-keep");
    storage.savePaper(paper);

    const duplicateBackup = makeBackup(
      [
        makePaper("duplicate-a", "duplicate-hash"),
        makePaper("duplicate-b", "duplicate-hash"),
      ],
      [],
    );
    expect(() => storage.importBackup(duplicateBackup)).toThrow(/重复/);
    expect(storage.listPaperMetas().map((meta) => meta.id)).toEqual(["keep-paper"]);
  });

  it("pins papers to the top of the library", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    storage.savePaper(makePaper("a", "hash-a", "A", { updatedAt: "2026-01-01T00:00:00.000Z" }));
    storage.savePaper(makePaper("b", "hash-b", "B", { updatedAt: "2026-01-02T00:00:00.000Z" }));
    storage.savePaper(makePaper("c", "hash-c", "C", { updatedAt: "2026-01-03T00:00:00.000Z" }));
    // 未置顶时按 updated_at 倒序
    expect(storage.listPaperMetas().map((meta) => meta.id)).toEqual(["c", "b", "a"]);

    storage.setPaperPinned("a", true);
    let metas = storage.listPaperMetas();
    expect(metas.map((meta) => meta.id)).toEqual(["a", "c", "b"]);
    expect(metas[0].pinned).toBe(true);
    expect(metas[1].pinned).toBe(false);

    // 再置顶一篇：排到置顶组最前
    storage.setPaperPinned("b", true);
    metas = storage.listPaperMetas();
    expect(metas.map((meta) => meta.id)).toEqual(["b", "a", "c"]);
    expect(metas.filter((meta) => meta.pinned).map((meta) => meta.id)).toEqual(["b", "a"]);

    // 取消置顶：排到未置顶组最后
    storage.setPaperPinned("a", false);
    metas = storage.listPaperMetas();
    expect(metas.map((meta) => meta.id)).toEqual(["b", "c", "a"]);
    expect(metas[0].pinned).toBe(true);
  });

  it("persists manual reorder and keeps pinned group first", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    storage.savePaper(makePaper("p1", "hash-p1", "P1"));
    storage.savePaper(makePaper("p2", "hash-p2", "P2"));
    storage.savePaper(makePaper("u1", "hash-u1", "U1"));
    storage.savePaper(makePaper("u2", "hash-u2", "U2"));
    storage.setPaperPinned("p1", true);
    storage.setPaperPinned("p2", true);

    // 完整显示顺序：置顶组在前、未置顶组在后
    storage.reorderPapers(["p2", "p1", "u2", "u1"]);
    expect(storage.listPaperMetas().map((meta) => meta.id)).toEqual(["p2", "p1", "u2", "u1"]);

    // 再次保存论文不应重置置顶状态
    storage.savePaper(makePaper("p1", "hash-p1", "P1", { pinned: true }));
    expect(storage.listPaperMetas()[0].id).toBe("p2");
    expect(storage.listPaperMetas().map((meta) => meta.pinned)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("roundtrips pinned state through backup", () => {
    const dir = tempDir();
    storage = openStorage({ dbPath: path.join(dir, "paper.db") });
    const paper = makePaper("pin-paper", "hash-pin", "Pin Paper", { pinned: true });
    storage.savePaper(paper);
    expect(storage.listPaperMetas()[0].pinned).toBe(true);
    const backup = storage.buildBackup();
    expect(backup.papers[0].pinned).toBe(true);

    const dir2 = tempDir();
    const storage2 = openStorage({ dbPath: path.join(dir2, "paper.db") });
    storage2.importBackup(makeBackup(backup.papers, backup.workspaces));
    expect(storage2.listPaperMetas()[0].pinned).toBe(true);
    storage2.close();
  });
});
