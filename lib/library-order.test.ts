import { describe, expect, it } from "vitest";
import type { PaperMeta } from "./types";
import { sortByRecentReading } from "./library-order";

function paper(id: string, options: Partial<PaperMeta> = {}): PaperMeta {
  return {
    id,
    title: id,
    fileName: `${id}.pdf`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pageCount: 1,
    ...options,
  };
}

describe("recent-reading library order", () => {
  it("sorts read papers by last reading time and unread papers by added time", () => {
    const papers = [
      paper("older-read", { lastReadAt: "2026-09-10T09:00:00.000Z" }),
      paper("new-unread", { createdAt: "2026-09-12T09:00:00.000Z" }),
      paper("newer-read", { lastReadAt: "2026-09-11T09:00:00.000Z" }),
      paper("old-unread", { createdAt: "2026-09-02T09:00:00.000Z" }),
    ];
    expect(sortByRecentReading(papers).map(({ id }) => id)).toEqual([
      "newer-read", "older-read", "new-unread", "old-unread",
    ]);
  });

  it("keeps pinned papers first and orders each group by recent reading", () => {
    const papers = [
      paper("recent", { lastReadAt: "2026-09-12T00:00:00.000Z" }),
      paper("pinned-old", { pinned: true, lastReadAt: "2026-09-01T00:00:00.000Z" }),
      paper("pinned-new", { pinned: true, lastReadAt: "2026-09-11T00:00:00.000Z" }),
    ];
    expect(sortByRecentReading(papers).map(({ id }) => id)).toEqual([
      "pinned-new", "pinned-old", "recent",
    ]);
  });

  it("does not mutate the stored manual order", () => {
    const papers = [paper("a"), paper("b")];
    sortByRecentReading(papers);
    expect(papers.map(({ id }) => id)).toEqual(["a", "b"]);
  });
});
