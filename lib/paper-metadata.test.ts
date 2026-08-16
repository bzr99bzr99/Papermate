import { describe, expect, it, vi } from "vitest";
import {
  extractDoi,
  extractJournalFromText,
  extractKeywordsFromText,
  inferTitleFromBlocks,
  inferTitleFromText,
  isWeakPaperTitle,
  lookupPaperMetadata,
} from "./paper-metadata";

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe("paper metadata", () => {
  it("extracts DOI, keywords, and a title locally", () => {
    expect(extractDoi("https://doi.org/10.1000/abc.123.")).toBe("10.1000/abc.123");
    expect(extractKeywordsFromText("Abstract\nKeywords: NLP, LLM; Agents\n"))
      .toEqual(["NLP", "LLM", "Agents"]);
    expect(extractKeywordsFromText("关键词：神经网络、大模型")).toEqual([
      "神经网络",
      "大模型",
    ]);
    expect(
      inferTitleFromText("Journal of X\n\nA Study of Models\nAbstract\n"),
    ).toBe("A Study of Models");
  });

  it("keeps PDF metadata title and fills Crossref and OpenAlex fields", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("api.crossref.org/works/")) {
        return jsonResponse({
          message: {
            title: ["Crossref Title"],
            "container-title": ["Journal of Testing"],
            ISSN: ["1234-5678"],
            subject: ["Subject A"],
          },
        });
      }
      if (url.includes("api.openalex.org/works/doi:")) {
        return jsonResponse({
          primary_location: {
            source: {
              display_name: "Journal of Testing",
              summary_stats: { "2yr_mean_citedness": 9.876 },
            },
          },
          keywords: [{ display_name: "Transformers" }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await lookupPaperMetadata(
      {
        title: "sample.pdf",
        metadataTitle: "PDF Title",
        text: "A Study of Models\nKeywords: Local A; Local B\n10.1000/abc",
      },
      fetcher as unknown as typeof fetch,
    );
    expect(result.title).toBe("PDF Title");
    expect(result.journal).toBe("Journal of Testing");
    expect(result.impactFactor).toBe("9.88");
    expect(result.keywords).toEqual(["Local A", "Local B"]);
  });

  it("uses Crossref and OpenAlex keywords when the PDF has none", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("api.crossref.org/works?")) {
        return jsonResponse({
          message: {
            items: [
              {
                title: ["A Study of Models for Neural Systems"],
                "container-title": ["Journal of Testing"],
                ISSN: ["1234-5678"],
                subject: ["Subject A"],
              },
            ],
          },
        });
      }
      if (url.includes("api.openalex.org/sources?filter=issn:")) {
        return jsonResponse({
          results: [
            {
              display_name: "Journal of Testing",
              summary_stats: { "2yr_mean_citedness": 4.2 },
            },
          ],
        });
      }
      if (url.includes("api.openalex.org/works?search=")) {
        return jsonResponse({
          results: [
            {
              title: ["A Study of Models for Neural Systems"],
              primary_location: {
                source: { display_name: "Journal of Testing" },
              },
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await lookupPaperMetadata(
      {
        title: "sample.pdf",
        text: "A Study of Models",
      },
      fetcher as unknown as typeof fetch,
    );
    expect(result.title).toBe("A Study of Models for Neural Systems");
    expect(result.keywords).toEqual(["Subject A"]);
    expect(result.impactFactor).toBe("4.20");
  });

  it("falls back to local parsing when the network is unavailable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await lookupPaperMetadata(
      {
        text: "A Study of Models\nKeywords: Alpha, Beta",
      },
      fetcher as unknown as typeof fetch,
    );
    expect(result.title).toBe("A Study of Models");
    expect(result.keywords).toEqual(["Alpha", "Beta"]);
    expect(result.journal).toBeUndefined();
    expect(result.impactFactor).toBeUndefined();
  });

  it("returns an empty patch when nothing can be resolved", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await lookupPaperMetadata(
      {},
      fetcher as unknown as typeof fetch,
    );
    expect(result).toEqual({});
  });

  it("infers a title from first-page blocks and merges wrapped lines", () => {
    const blocks = [
      { text: "Nature Communications", fontSize: 9, top: 20, kind: "paragraph" },
      { text: "A Study of Models", fontSize: 18, top: 90, kind: "heading" },
      { text: "for Neural Systems", fontSize: 18, top: 108, kind: "heading" },
      { text: "John Smith, Jane Doe", fontSize: 10, top: 140, kind: "paragraph" },
    ];
    expect(inferTitleFromBlocks(blocks, 800)).toBe(
      "A Study of Models for Neural Systems",
    );
  });

  it("merges wrapped title lines after PDF.js coordinate conversion", () => {
    const blocks = [
      { text: "Surrogate-Assisted Evolutionary Multi-Objective", fontSize: 23.91, top: 79, kind: "heading" },
      { text: "Optimization of Medium-Scale Problems by Random", fontSize: 23.91, top: 107, kind: "paragraph" },
      { text: "Grouping and Sparse Gaussian Modeling", fontSize: 23.91, top: 135, kind: "paragraph" },
      { text: "Haofeng Wu, Yaochu Jin, Ran Cheng", fontSize: 10.96, top: 158, kind: "paragraph" },
    ];
    expect(inferTitleFromBlocks(blocks, 792)).toBe(
      "Surrogate-Assisted Evolutionary Multi-Objective Optimization of Medium-Scale Problems by Random Grouping and Sparse Gaussian Modeling",
    );
  });

  it("does not use a journal header as the paper title", () => {
    expect(
      inferTitleFromBlocks(
        [
          { text: "Nature Communications", fontSize: 12, top: 20, kind: "heading" },
          { text: "Volume 12, Issue 3", fontSize: 10, top: 40, kind: "paragraph" },
        ],
        800,
      ),
    ).toBeUndefined();
    expect(
      inferTitleFromText("Journal of Testing\nA Study of Models\nAbstract\n"),
    ).toBe("A Study of Models");
  });

  it("extracts journal names from common first-page layouts", () => {
    expect(
      extractJournalFromText(
        "This work was published in Journal of Machine Learning Research, 2024.",
      ),
    ).toBe("Journal of Machine Learning Research");
    expect(extractJournalFromText("Nature Communications\n\nAbstract\n")).toBe(
      "Nature Communications",
    );
    expect(extractJournalFromText("发表于《计算机学报》，2024")).toBe("计算机学报");
    expect(extractJournalFromText("Google Research\nGoogle Brain\n\nAbstract\n")).toBeUndefined();
    expect(
      extractJournalFromText(
        "IEEE Transactions on Pattern Analysis and Machine Intelligence\n\nAbstract\n",
      ),
    ).toBe("IEEE Transactions on Pattern Analysis and Machine Intelligence");
    expect(
      extractJournalFromText(
        "IEEE Transactions on Emerging Topics in Computational Intelligence, VOL. 8, NO. 5, OCTOBER 2024",
      ),
    ).toBe("IEEE Transactions on Emerging Topics in Computational Intelligence");
    expect(
      extractJournalFromText(
        "IEEE TRANSACTIONS ON EMERGING TOPICS IN COMPUTATIONAL INTELLIGENCE, VOL. 8, NO. 5",
      ),
    ).toBe("IEEE Transactions on Emerging Topics in Computational Intelligence");
    expect(
      extractJournalFromText(
        "This article has been accepted for publication in IEEE Transactions on Evolutionary Computation. This is the author's version which has not been fully edited.",
      ),
    ).toBe("IEEE Transactions on Evolutionary Computation");
  });

  it("parses Index Terms and multiline keyword sections", () => {
    expect(
      extractKeywordsFromText(
        "Index Terms—Machine Learning; Natural Language Processing\n\nIntroduction",
      ),
    ).toEqual(["Machine Learning", "Natural Language Processing"]);
    expect(
      extractKeywordsFromText("Keywords:\nLLM\nNLP\n10.1000/abc.123"),
    ).toEqual(["LLM", "NLP"]);
    expect(
      extractKeywordsFromText(
        "Index Terms—Multi-objective optimization, medium-scale\nManuscript received 1 March 2023",
      ),
    ).toEqual(["Multi-objective optimization", "medium-scale"]);
    expect(
      extractKeywordsFromText(
        "Index Terms—Physics-informed neural networks, neural architecture search\nI. Introduction",
      ),
    ).toEqual(["Physics-informed neural networks", "neural architecture search"]);
    expect(
      extractKeywordsFromText(
        "Keywords: data augmentation, fault diagnosis\nAbstract\nhowever",
      ),
    ).toEqual(["data augmentation", "fault diagnosis"]);
    expect(
      extractKeywordsFromText(
        "Index Terms —Physics-informed neural networks, neural ar-\nchitecture search, self-\nattention mechanism\nAbstract",
      ),
    ).toEqual([
      "Physics-informed neural networks",
      "neural architecture search",
      "self-attention mechanism",
    ]);
  });

  it("treats file names and untitled metadata as weak titles", () => {
    expect(isWeakPaperTitle("my-paper.pdf")).toBe(true);
    expect(isWeakPaperTitle("untitled")).toBe(true);
    expect(isWeakPaperTitle("A Study of Models")).toBe(false);
  });

  it("ignores license boilerplate and picks the actual paper title", () => {
    const text = [
      "Provided proper attribution is provided, Google hereby grants permission to",
      "reproduce the tables and figures in this paper solely for use in journalistic or",
      "scholarly works.",
      "Attention Is All You Need",
      "Ashish Vaswani",
      "Abstract",
    ].join("\n");
    expect(inferTitleFromText(text)).toBe("Attention Is All You Need");
    expect(
      inferTitleFromBlocks(
        [
          {
            text: "Provided proper attribution is provided, Google hereby grants permission to",
            fontSize: 11.96,
            top: 710.04,
            kind: "paragraph",
          },
          { text: "Attention Is All You Need", fontSize: 17.22, top: 629.96, kind: "heading" },
          { text: "Ashish Vaswani", fontSize: 9.96, top: 549.31, kind: "paragraph" },
        ],
        792,
      ),
    ).toBe("Attention Is All You Need");
    expect(
      isWeakPaperTitle(
        "Provided proper attribution is provided, Google hereby grants permission to",
      ),
    ).toBe(true);
  });
});
