import type { PaperMeta } from "./types";
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function sortByRecentReading(papers: PaperMeta[]): PaperMeta[] {
  return [...papers].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
    || timestamp(b.lastReadAt) - timestamp(a.lastReadAt)
    || timestamp(b.createdAt) - timestamp(a.createdAt));
}
