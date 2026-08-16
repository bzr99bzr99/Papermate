import { describe, expect, it } from "vitest";
import { backupToPaper, buildBackup, emptyBackup } from "./backup";
import type { Paper, PaperWorkspace } from "./types";

describe("paper library backup", () => {
  const paper: Paper = {
    id: "paper-1",
    title: "Sample Paper",
    fileName: "sample.pdf",
    file: new Blob(["%PDF-1.4 sample"], { type: "application/pdf" }),
    sourceHash: "abc123",
    note: "阅读备注",
    keywords: ["NLP", "LLM"],
    journal: "Journal of Testing",
    impactFactor: "12.34",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    pages: [],
    pageCount: 1,
    originalReady: false,
  };

  const workspace: PaperWorkspace & { paperId: string } = {
    paperId: "paper-1",
    annotations: [],
    conversations: [
      {
        id: "conversation-1",
        paperId: "paper-1",
        title: "测试问答",
        turns: [
          {
            id: "turn-1",
            role: "user",
            content: "解释第一段",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "turn-2",
            role: "assistant",
            content: "第一段说明研究动机。",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    artifacts: [],
  };

  it("roundtrips papers, PDF blobs, notes, and workspaces", async () => {
    const backup = await buildBackup([paper], [workspace]);
    expect(backup.version).toBe(1);
    expect(backup.papers[0].file.base64).toBe("JVBERi0xLjQgc2FtcGxl");
    expect(backup.papers[0].note).toBe("阅读备注");
    expect(backup.papers[0].keywords).toEqual(["NLP", "LLM"]);
    expect(backup.papers[0].journal).toBe("Journal of Testing");
    expect(backup.papers[0].impactFactor).toBe("12.34");
    expect(backup.workspaces[0].conversations[0].turns[1].content).toContain("研究动机");

    const restored = backupToPaper(backup.papers[0]);
    expect(restored.id).toBe("paper-1");
    expect(restored.note).toBe("阅读备注");
    expect(restored.keywords).toEqual(["NLP", "LLM"]);
    expect(restored.journal).toBe("Journal of Testing");
    expect(restored.impactFactor).toBe("12.34");
    expect(await restored.file.text()).toBe("%PDF-1.4 sample");
  });

  it("returns a valid empty backup before anything is saved", () => {
    const backup = emptyBackup();
    expect(backup.version).toBe(1);
    expect(backup.papers).toEqual([]);
    expect(backup.workspaces).toEqual([]);
  });

  it("roundtrips theme and layout settings with the backup", async () => {
    const backup = await buildBackup([paper], [workspace], {
      theme: "dark",
      layout: {
        leftWidth: 260,
        rightWidth: 420,
        leftCollapsed: false,
        rightCollapsed: true,
      },
    });
    expect(backup.settings?.theme).toBe("dark");
    expect(backup.settings?.layout).toEqual({
      leftWidth: 260,
      rightWidth: 420,
      leftCollapsed: false,
      rightCollapsed: true,
    });
  });
});
