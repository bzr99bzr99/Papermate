import { openDB, type DBSchema } from "idb";
import { blobSha256 } from "@/lib/source-hash";
import type { Paper, PaperWorkspace } from "@/lib/types";

interface PaperCompanionDB extends DBSchema {
  papers: {
    key: string;
    value: Paper;
    indexes: { "by-updated": string };
  };
  workspaces: {
    key: string;
    value: PaperWorkspace & { paperId: string };
  };
}

const database = () =>
  openDB<PaperCompanionDB>("paper-companion", 1, {
    upgrade(db) {
      const papers = db.createObjectStore("papers", { keyPath: "id" });
      papers.createIndex("by-updated", "updatedAt");
      db.createObjectStore("workspaces", { keyPath: "paperId" });
    },
  });

export async function listPapers() {
  const db = await database();
  return (await db.getAllFromIndex("papers", "by-updated")).reverse();
}

export async function listWorkspaces() {
  return (await database()).getAll("workspaces");
}

export async function replaceAll(
  papers: Paper[],
  workspaces: Array<PaperWorkspace & { paperId: string }>,
) {
  const db = await database();
  const tx = db.transaction(["papers", "workspaces"], "readwrite");
  await tx.objectStore("papers").clear();
  await tx.objectStore("workspaces").clear();
  for (const paper of papers) {
    await tx.objectStore("papers").put(paper);
  }
  for (const workspace of workspaces) {
    await tx.objectStore("workspaces").put(workspace);
  }
  await tx.done;
}

export async function getPaper(id: string) {
  return (await database()).get("papers", id);
}

export async function savePaper(paper: Paper) {
  return (await database()).put("papers", paper);
}

export async function findPaperBySourceHash(sourceHash: string) {
  const db = await database();
  const papers = await db.getAll("papers");
  for (const paper of papers) {
    let hash = paper.sourceHash;
    if (!hash && paper.file) {
      try {
        hash = await blobSha256(paper.file);
        await db.put("papers", { ...paper, sourceHash: hash });
      } catch {
        continue;
      }
    }
    if (hash === sourceHash) return paper;
  }
  return undefined;
}

export async function updatePaperNote(id: string, note: string) {
  const db = await database();
  const paper = await db.get("papers", id);
  if (!paper) return;
  await db.put("papers", { ...paper, note });
}

export async function deletePaper(id: string) {
  const db = await database();
  await db.delete("papers", id);
  await db.delete("workspaces", id);
}

export async function getWorkspace(paperId: string): Promise<PaperWorkspace> {
  const item = await (await database()).get("workspaces", paperId);
  return item ?? { annotations: [], conversations: [], artifacts: [] };
}

export async function saveWorkspace(paperId: string, workspace: PaperWorkspace) {
  return (await database()).put("workspaces", { ...workspace, paperId });
}
