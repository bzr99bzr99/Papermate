import { describe, expect, it } from "vitest";
import { activeIndexTurn, hasCompletedTranslation, HISTORY_MESSAGE_LIMIT, buildHistoryMessages, buildSelectionRequest, conversationMatchesSelection, mergeSelectionConversations, selectionKey } from "./conversations";
import { deriveHighlightRegions, makeAnchor, selectionGroupForAnchors } from "./pdf";
import type { ChatTurn, Conversation, ParsedPage, PromptKind } from "./types";

const page: ParsedPage = { page: 2, text: "Before. Selected. After.", blocks: [], figures: [] };
const anchor = makeAnchor("paper", page, "Selected.", 8, "Methods");
const selection = selectionGroupForAnchors("paper", [anchor]);
function pair(id: string, kind: PromptKind, time = id): ChatTurn[] {
  return [
    { id: `${id}-u`, role: "user", content: "same question", createdAt: time, kind, anchor },
    { id: `${id}-a`, role: "assistant", content: `${id} answer`, createdAt: time, kind, anchor },
  ];
}
function conversation(id: string, turns: ChatTurn[], scope: "normal" | "context" = "normal"): Conversation {
  return { id, paperId: "paper", anchor, selection, title: id, color: "sage", scope, turns, updatedAt: turns.at(-1)!.createdAt };
}

describe("shared selection conversations", () => {
  it("matches exact ranges across task types and fragment order, not text or overlapping selections", () => {
    const c = conversation("c", pair("1", "translate"));
    expect(conversationMatchesSelection(c, selection)).toBe(true);
    expect(conversationMatchesSelection({ ...c, scope: "context" }, selection)).toBe(true);
    expect(conversationMatchesSelection(c, undefined, { ...anchor, end: anchor.end + 1 })).toBe(false);
    expect(conversationMatchesSelection(c, undefined, { ...anchor, start: 99, end: 108 })).toBe(false);
    const precise = { ...anchor, textItemStart: 5, textItemEnd: 5, textStartOffset: 0, textEndOffset: 9 };
    const repeated = { ...precise, textItemStart: 15, textItemEnd: 15 };
    expect(selectionKey("paper", [precise])).not.toBe(selectionKey("paper", [repeated]));
    expect(conversationMatchesSelection(c, { ...selection!, paperId: "another" })).toBe(false);
    const other = { ...anchor, page: 3 };
    expect(selectionKey("paper", [anchor, other])).toBe(selectionKey("paper", [other, anchor]));
    expect(conversationMatchesSelection(c, selectionGroupForAnchors("paper", [anchor, other]))).toBe(false);
  });

  it("merges old scopes chronologically, retaining earliest identity, colors and per-turn tags", () => {
    const early = conversation("early", pair("1", "translate"));
    const later = { ...conversation("later", pair("2", "context"), "context"), color: "sky" as const };
    const merged = mergeSelectionConversations([later, early, { ...early, id: "duplicate" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "early", color: "sage", scope: "normal", title: "Methods选段" });
    expect(merged[0].turns.map((t) => t.id)).toEqual(["1-u", "1-a", "2-u", "2-a"]);
    expect(merged[0].turns.map((t) => t.kind)).toEqual(["translate", "translate", "context", "context"]);
    expect(mergeSelectionConversations(merged)).toEqual(merged);
    expect(deriveHighlightRegions(merged)[0].conversationIds).toEqual(["early"]);
    expect(buildHistoryMessages(merged[0].turns.filter((t) => !t.id.startsWith("1-")))).toHaveLength(2);
  });

  it("does not merge distinct positions or unselected conversations", () => {
    const c = conversation("c", pair("1", "free"));
    const moved = { ...anchor, start: 88, end: 97 };
    expect(mergeSelectionConversations([c, { ...c, id: "d", selection: undefined, anchor: moved }])).toHaveLength(2);
    expect(mergeSelectionConversations([c, { ...c, id: "d", selection: undefined, anchor: undefined }])).toHaveLength(2);
  });
});

describe("per-request context", () => {
  it("keeps a new selection translation separate from the previous selection and its history", () => {
    const previous = conversation("previous", pair("1", "translate"));
    const nextAnchor = makeAnchor("paper", page, "After.", 18);
    const nextSelection = selectionGroupForAnchors("paper", [nextAnchor]);
    expect(conversationMatchesSelection(previous, nextSelection)).toBe(false);
    expect(buildSelectionRequest("translate", [page], [nextAnchor], previous.turns, "FULL PAPER"))
      .toEqual({ requestContext: "After.", historyMessages: [] });
    const next = { ...conversation("next", pair("2", "translate")), anchor: nextAnchor, selection: nextSelection };
    expect(conversationMatchesSelection(next, nextSelection)).toBe(true);
    expect(hasCompletedTranslation(next)).toBe(true);
    expect(buildSelectionRequest("free", [page], [nextAnchor], next.turns, "FULL PAPER").historyMessages)
      .toEqual(buildHistoryMessages(next.turns));
  });
  it("retries empty or missing translations but reuses a completed translation", () => {
    const turns = pair("1", "translate");
    expect(hasCompletedTranslation(conversation("c", turns))).toBe(true);
    expect(hasCompletedTranslation(conversation("c", [turns[0]]))).toBe(false);
    expect(hasCompletedTranslation(conversation("c", [turns[0], { ...turns[1], content: "  " }]))).toBe(false);
    expect(hasCompletedTranslation(conversation("c", pair("2", "free")))).toBe(false);
  });

  it("keeps a clicked old index item through streaming updates and falls back after deletion", () => {
    const turns = [...pair("1", "translate"), ...pair("2", "context")];
    expect(activeIndexTurn(turns, "1-u")).toBe("1-u");
    expect(activeIndexTurn([...turns, ...pair("3", "free")], "1-u")).toBe("1-u");
    expect(activeIndexTurn(turns.slice(2), "1-u")).toBe("2-u");
    expect(activeIndexTurn([], "1-u")).toBeUndefined();
  });
  it("keeps translation isolated while sharing its results with both Q&A modes", () => {
    const translated = pair("1", "translate");
    const request = (kind: PromptKind, turns = translated) => buildSelectionRequest(kind, [page], [anchor], turns, "FULL PAPER DIGEST");
    expect(request("translate")).toEqual({ historyMessages: [], requestContext: "Selected." });
    expect(request("free")).toEqual({ historyMessages: buildHistoryMessages(translated), requestContext: "Selected." });
    const context = request("context");
    expect(context.requestContext).toContain("FULL PAPER DIGEST");
    expect(context.historyMessages).toEqual(buildHistoryMessages(translated));
    const history = [...translated, ...pair("2", "context")];
    expect(request("free", history).requestContext).toBe("Selected.");
    expect(request("free", history).historyMessages).toHaveLength(4);
    expect(request("translate", history).historyMessages).toEqual([]);
    expect(request("context", history).requestContext).toContain("FULL PAPER DIGEST");
    expect(history.some((turn) => turn.content.includes("FULL PAPER DIGEST"))).toBe(false);
  });

  it("keeps the last six complete pairs, excluding empty or orphan answers", () => {
    const history = Array.from({ length: 8 }, (_, index) => pair(String(index), "free")).flat();
    history.push(...pair("empty", "free").map((turn) => turn.role === "assistant" ? { ...turn, content: " " } : turn));
    expect(buildHistoryMessages(history)).toEqual(buildHistoryMessages(history.slice(4, 16)));
    expect(buildHistoryMessages(history)).toHaveLength(12);
    expect(buildHistoryMessages(history).slice(-HISTORY_MESSAGE_LIMIT)).toHaveLength(12);
    expect(buildHistoryMessages([history[1]])).toEqual([]);
  });
});
