/**
 * 划选取值：把「指针位置 + 文本项几何」换算成「选中了哪些文本项、文本是什么」。
 * 抽成纯函数是因为这里出过一个很隐蔽的 bug（见 selectItemIndexes 注释），
 * 必须有回归测试兜住。
 *
 * 背景：PDF 的文本层不是一行一个节点，而是**一行被切成一堆片段**（每个片段是
 * 一个绝对定位的 span），而且 `page.textItems` 的顺序是 PDF 内容流顺序，不一定
 * 等于阅读顺序。所以选中区间不能只按 DOM 顺序切，必须用几何信息判断。
 */

export interface SelectionItemBox {
  /** 对应 page.textItems 的下标（DOM 上的 data-text-item-index）。 */
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ItemSelectionInput {
  /** 本页文本项的矩形，可按 index 升序；缺尺寸的项可直接不传。 */
  boxes: SelectionItemBox[];
  /** 起点/终点文本项的下标（已归一化为 low <= high）。 */
  lowIndex: number;
  highIndex: number;
  /** 指针按下与抬起的 Y 坐标，已含容差。 */
  pointerTop: number;
  pointerBottom: number;
}

/** 列带在两端文本项之外额外放宽的像素。 */
const COLUMN_PADDING = 6;
/** 行内片段间隙超过「字高 × 这个系数」就认为跨了栏。 */
const COLUMN_GAP_RATIO = 0.8;
/** 列间隙的最小阈值（字号很小时兜底）。 */
const MIN_COLUMN_GAP = 6;

const boxHeight = (box: SelectionItemBox) => Math.max(0, box.bottom - box.top);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** 按纵向重叠把片段归成行（PDF 文本层里一行会被切成很多片段）。 */
function groupRows(boxes: SelectionItemBox[]): SelectionItemBox[][] {
  const rows: SelectionItemBox[][] = [];
  for (const box of [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const row = rows.at(-1);
    const reference = row?.[0];
    if (row && reference) {
      const overlap = Math.min(box.bottom, reference.bottom) - Math.max(box.top, reference.top);
      // 垂直重叠超过较矮片段的一半即视为同一行
      if (overlap > Math.min(boxHeight(box), boxHeight(reference)) * 0.5) {
        row.push(box);
        continue;
      }
    }
    rows.push([box]);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows;
}

/**
 * 把一行按水平大间隙切成「段」：段内是连续的正文片段，段与段之间是分栏/大空白。
 * 选中时以段为单位整体纳入，这样同一行的行首/行尾片段不会被漏掉。
 */
function splitSegments(row: SelectionItemBox[], gap: number): SelectionItemBox[][] {
  const segments: SelectionItemBox[][] = [];
  for (const box of row) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    if (segment && previous && box.left - previous.right <= gap) segment.push(box);
    else segments.push([box]);
  }
  return segments;
}

/**
 * 选出区间内真正被划到的文本项下标（升序）。
 *
 * 语义：**中间的行整行选中，首尾两行由偏移裁剪**；列带只用来区分分栏，
 * 不能用来裁剪同一行更宽的片段。
 *
 * 这里是两个踩过的坑，都表现为「丢失部分划选内容、整行选不全」：
 * 1. 列带曾经取两端文本项的**交集**：从某行中段拖到另一行中段时，列带会窄到只有
 *    几十像素，中间那些更宽的行就只剩落在窄带里的片段被选中。
 * 2. 判定曾经用**片段中心点**是否落在 ±2px 的指针带内：指针停在某行上边缘（或两行
 *    之间）时，那一行其余片段的中心会落在带外，整行前半段被丢掉。
 *
 * 现在的做法：先按行分组、再按大间隙分段；与指针 Y 带相交的行里，
 * 包含端点的那一段整段纳入，其余段只要与端点列带相交就整段纳入。
 * 同时保留 index 窗口（lowIndex..highIndex），避免把相邻行/另一栏的片段卷进来。
 */
export function selectItemIndexes(input: ItemSelectionInput): number[] {
  const { boxes, lowIndex, highIndex } = input;
  const inWindow = boxes
    .filter((box) => box.index >= lowIndex && box.index <= highIndex)
    .sort((a, b) => a.index - b.index);
  if (!inWindow.length) return [];

  const lowBox = inWindow.find((box) => box.index === lowIndex);
  const highBox = inWindow.find((box) => box.index === highIndex);
  const anchors = [lowBox, highBox].filter((box): box is SelectionItemBox => Boolean(box));
  // 两端都没有几何信息（异常情况）时退化为纯 index 窗口，宁可多选也不要漏内容。
  if (!anchors.length) return inWindow.map((box) => box.index);

  const columnLeft = Math.min(...anchors.map((box) => box.left)) - COLUMN_PADDING;
  const columnRight = Math.max(...anchors.map((box) => box.right)) + COLUMN_PADDING;
  const gap = Math.max(MIN_COLUMN_GAP, median(inWindow.map(boxHeight)) * COLUMN_GAP_RATIO);

  const selected = new Set<number>([lowIndex, highIndex]);
  for (const row of groupRows(inWindow)) {
    const rowTop = Math.min(...row.map((box) => box.top));
    const rowBottom = Math.max(...row.map((box) => box.bottom));
    // 端点在的那一行永远参与（用户就是从这一行按下/抬起的）；
    // 其余行必须与指针划过的纵向区间相交才算被划到。
    const holdsAnchorRow = row.some((box) => box.index === lowIndex || box.index === highIndex);
    if (!holdsAnchorRow && (rowBottom < input.pointerTop || rowTop > input.pointerBottom)) continue;
    for (const segment of splitSegments(row, gap)) {
      const holdsAnchor = segment.some((box) => box.index === lowIndex || box.index === highIndex);
      const segmentLeft = Math.min(...segment.map((box) => box.left));
      const segmentRight = Math.max(...segment.map((box) => box.right));
      // 端点在的段整段选中（首尾两行由 lowOffset/highOffset 裁剪）；
      // 其余段只要与端点列带相交就整段选中，避免同一行只选到半截。
      if (holdsAnchor || (segmentRight >= columnLeft && segmentLeft <= columnRight)) {
        for (const box of segment) selected.add(box.index);
      }
    }
  }
  return [...selected].sort((a, b) => a - b);
}

interface QuoteItem {
  str: string;
  hasEOL?: boolean;
  blockId?: string;
}

interface QuoteInput {
  items: QuoteItem[];
  itemIndexes: number[];
  lowIndex: number;
  highIndex: number;
  lowOffset: number;
  highOffset: number;
}

/** 按选中的下标拼出引用文本（保留行尾换行、压缩空白），并记录涉及的文本块。 */
export function buildSelectionQuote(input: QuoteInput): { quote: string; blockIds: string[] } {
  const { items, itemIndexes, lowIndex, highIndex, lowOffset, highOffset } = input;
  const quoteParts: string[] = [];
  const blockIds: string[] = [];
  for (let position = 0; position < itemIndexes.length; position += 1) {
    const index = itemIndexes[position];
    const item = items[index];
    if (!item) continue;
    let value = item.str;
    if (lowIndex === highIndex) value = item.str.slice(lowOffset, highOffset);
    else if (index === lowIndex) value = item.str.slice(lowOffset);
    else if (index === highIndex) value = item.str.slice(0, highOffset);
    quoteParts.push(value);
    // 行尾换行只在后面还有选中项时补，避免结尾多一个空行
    if (item.hasEOL && position < itemIndexes.length - 1) quoteParts.push("\n");
    if (item.blockId) blockIds.push(item.blockId);
  }
  const quote = quoteParts
    .join("")
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
  return { quote, blockIds: [...new Set(blockIds)] };
}
