import { afterEach, describe, expect, it, vi } from "vitest";

describe("reader quotes loader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads quotes from the project text file, skipping comments", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# comment\n一句一。\n二句二。\n\n三句三。")),
    );
    const { loadReaderQuotes } = await import("./quotes");
    expect(await loadReaderQuotes()).toEqual(["一句一。", "二句二。", "三句三。"]);
  });

  it("falls back to built-in quotes when the file is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { loadReaderQuotes, READER_QUOTES } = await import("./quotes");
    expect(await loadReaderQuotes()).toEqual([...READER_QUOTES]);
  });

  it("falls back to built-in quotes when the file is empty", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# only a comment\n")));
    const { loadReaderQuotes, READER_QUOTES } = await import("./quotes");
    expect(await loadReaderQuotes()).toEqual([...READER_QUOTES]);
  });
});
