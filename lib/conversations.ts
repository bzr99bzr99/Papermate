import { buildContext, buildTranslationContext } from "./pdf";
import type { ChatTurn, Conversation, ParsedPage, PromptKind, SelectionGroup, TextAnchor } from "./types";

export const HISTORY_MESSAGE_LIMIT = 12;

export function hasCompletedTranslation(conversation: Conversation): boolean {
  return conversation.turns.some((turn, index) => turn.role === "user" && turn.kind === "translate"
    && conversation.turns[index + 1]?.role === "assistant"
    && Boolean(conversation.turns[index + 1]?.content.trim()));
}

export function activeIndexTurn(turns: ChatTurn[], current?: string): string | undefined {
  return turns.some((turn) => turn.role === "user" && turn.id === current)
    ? current : [...turns].reverse().find((turn) => turn.role === "user")?.id;
}

export function selectionKey(paperId: string, anchors: TextAnchor[]): string {
  const ranges = anchors.map((anchor) => [
    anchor.page, anchor.start, anchor.end,
    anchor.textItemStart ?? -1, anchor.textItemEnd ?? -1,
    anchor.textStartOffset ?? -1, anchor.textEndOffset ?? -1,
  ]);
  ranges.sort((a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  return JSON.stringify([paperId, ranges]);
}

function conversationAnchors(conversation: Conversation): TextAnchor[] {
  return conversation.selection?.anchors.length
    ? conversation.selection.anchors
    : conversation.anchor ? [conversation.anchor] : [];
}

export function conversationMatchesSelection(
  conversation: Conversation,
  selection?: SelectionGroup,
  anchor?: TextAnchor,
): boolean {
  const anchors = selection?.anchors ?? (anchor ? [anchor] : []);
  return anchors.length > 0 && selectionKey(selection?.paperId ?? conversation.paperId, anchors)
    === selectionKey(conversation.paperId, conversationAnchors(conversation));
}

export function selectionTitle(anchors: TextAnchor[]): string {
  return anchors.length > 1 ? `${anchors.length} 个片段问答`
    : anchors[0] ? `${anchors[0].section ?? `第 ${anchors[0].page} 页`}选段` : "全文问答";
}

/** 合并旧的按功能分组的会话；无选区会话保持独立。 */
export function mergeSelectionConversations(conversations: Conversation[]): Conversation[] {
  const groups = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    const anchors = conversationAnchors(conversation);
    const key = anchors.length ? selectionKey(conversation.paperId, anchors) : `unselected:${conversation.id}`;
    groups.set(key, [...(groups.get(key) ?? []), conversation]);
  }
  return [...groups.values()].map((group) => {
    const firstTime = (c: Conversation) => c.turns.reduce(
      (earliest, turn) => turn.createdAt < earliest ? turn.createdAt : earliest, c.updatedAt,
    );
    const ordered = [...group].sort((a, b) => firstTime(a).localeCompare(firstTime(b)));
    const first = ordered[0];
    const turns = [...new Map(ordered.flatMap((c) => c.turns).map((turn) => [turn.id, turn])).values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      ...first,
      scope: "normal" as const,
      title: selectionTitle(conversationAnchors(first)),
      turns,
      updatedAt: ordered.reduce((latest, c) => c.updatedAt > latest ? c.updatedAt : latest, first.updatedAt),
    };
  });
}

export function buildHistoryMessages(turns: ChatTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const pairs: ChatTurn[][] = [];
  for (let i = 0; i < turns.length - 1; i += 1) {
    const user = turns[i];
    const assistant = turns[i + 1];
    if (user.role === "user" && assistant.role === "assistant" && user.content.trim() && assistant.content.trim()) {
      pairs.push([user, assistant]);
      i += 1;
    }
  }
  return pairs.slice(-HISTORY_MESSAGE_LIMIT / 2).flat().map(({ role, content }) => ({ role, content }));
}

export function buildSelectionRequest(
  kind: PromptKind,
  pages: ParsedPage[],
  anchors: TextAnchor[],
  turns: ChatTurn[],
  digest: string,
) {
  const selectedText = buildTranslationContext(anchors);
  return {
    historyMessages: kind === "translate" ? [] : buildHistoryMessages(turns),
    requestContext: kind === "context"
      ? [digest.trim() ? `[论文全文摘要与结构]\n${digest}` : "", buildContext(pages, anchors)].filter(Boolean).join("\n\n")
      : selectedText,
  };
}
