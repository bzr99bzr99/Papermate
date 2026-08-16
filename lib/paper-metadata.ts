export interface PaperMetadataPatch {
  title?: string;
  keywords?: string[];
  journal?: string;
  impactFactor?: string;
}

export interface PaperMetadataBlockInput {
  text?: string;
  fontSize?: number;
  top?: number;
  kind?: string;
}

export interface PaperMetadataLookupInput {
  title?: string;
  text?: string;
  metadataTitle?: string;
  blocks?: PaperMetadataBlockInput[];
  pageHeight?: number;
}

interface OpenAlexSource {
  display_name?: string;
  summary_stats?: Record<string, unknown>;
}

interface OpenAlexWork {
  title?: string;
  keywords?: unknown;
  primary_location?: {
    source?: OpenAlexSource;
  };
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

interface CrossrefItem {
  title?: unknown;
  "container-title"?: unknown;
  ISSN?: unknown;
  subject?: unknown;
}

interface CrossrefResponse {
  message?: {
    items?: CrossrefItem[];
  } & CrossrefItem;
}

const LOOKUP_TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 60000;

function firstString(value: unknown): string | undefined {
  const values = toStringArray(value);
  return values[0];
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (item && typeof item === "object") {
      const candidate = item as { display_name?: unknown };
      if (typeof candidate.display_name === "string" && candidate.display_name.trim()) {
        return [candidate.display_name.trim()];
      }
    }
    return [];
  });
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`metadata request failed: ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export function extractDoi(text: string): string | undefined {
  const match = text.match(/\b10\.\d{4,9}\/[^\s]+/i);
  if (!match) return undefined;
  return match[0].replace(/[.,;:)\]}"']+$/, "");
}

const KEYWORD_LABEL_PATTERN =
  /(?:^|[.;:：\s])(?:Keywords?|Key\s+words|关键词|关键字|Index\s+Terms?)\s*[:：—]?\s*/i;

const KEYWORD_STOP_LINE_PATTERN =
  /\n\s*(?:(?:Abstract|Introduction|Conclusion|Conclusions|References|Methods|Results|Discussion|Funding|Acknowledg(?:ement|ements)?|Competing interests?|Corresponding author|Digital Object Identifier)\b|(?:Manuscript\s+)?(?:Received|Accepted|Submitted|Revised|Published)\b|Date\s+of\s+publication\b|This\s+work\s+was\s+supported\b|(?:[IVXLCDM]{1,3}|[1-9]\d{0,2})\s*\.\s+[A-Z][A-Za-z0-9 ]{2,}|10\.\d{4,9}\/|https?:\/\/|\S+@\S+|\b(?:ISSN|ORCID|PMID|arXiv)\s*[:=])/i;

const HYPHEN_PREFIX_PATTERN =
  /^(?:multi|self|semi|non|re|pre|co|bio|neuro|micro|macro|inter|intra|hyper|auto|cross|counter|sub|super|anti|post|over|under|mid|cyber|geo|hydro|electro|photo|thermo|radio|tele|audio|video|nano|meta|trans|ultra|infra|omni|poly|mono|pseudo|quasi|physics|machine|deep|sparse|random|fault|data|image|signal|graph|knowledge|transfer|generative|adversarial|attention|evolutionary|surrogate|gaussian|large|medium|small|high|low|end|state|real|online|offline|based|aware)$/i;

function rejoinHyphenatedWords(value: string): string {
  return value.replace(/([A-Za-z]+)-\s*\n?\s*([a-z])/g, (_match, left, right) =>
    HYPHEN_PREFIX_PATTERN.test(left) ? `${left}-${right}` : `${left}${right}`,
  );
}

export function extractKeywordsFromText(text: string): string[] {
  const match = text.match(KEYWORD_LABEL_PATTERN);
  if (!match || typeof match.index !== "number") return [];
  const tail = text
    .slice(match.index + match[0].length)
    .replace(/\r/g, "")
    .slice(0, 600)
    .replace(/[ \t]+/g, " ")
    .trim();
  const rejoinedTail = rejoinHyphenatedWords(tail);
  const stop = rejoinedTail.search(KEYWORD_STOP_LINE_PATTERN);
  const paragraph = (stop >= 0 ? rejoinedTail.slice(0, stop) : rejoinedTail).split(/\n{2,}/)[0] ?? "";
  const raw = paragraph
    .replace(
      /\s+(?:(?:Abstract|Introduction|Conclusion|Conclusions|References|Methods|Results|Discussion|Funding|Acknowledg(?:ement|ements)?|Competing interests?|Corresponding author|Digital Object Identifier)\b|(?:Manuscript\s+)?(?:Received|Accepted|Submitted|Revised|Published)\b|Date\s+of\s+publication\b|This\s+work\s+was\s+supported\b|(?:[IVXLCDM]{1,3}|[1-9]\d{0,2})\s*\.\s+[A-Z][A-Za-z0-9 ]{2,}).*$/i,
      "",
    )
    .replace(/\b(?:doi|issn|orcid|pmid|arxiv)\s*[:=]\s*\S+/gi, "")
    .trim();
  return raw
    .split(/\s*[;,；，、|]\s*|\n\s*/)
    .map((keyword) =>
      keyword
        .trim()
        .replace(/^[•·\-–—]\s*/, "")
        .replace(/[.。;；,，]+$/, ""),
    )
    .filter((keyword) => keyword.length >= 1 && keyword.length <= 80)
    .filter(
      (keyword) =>
        !/^10\.\d{4,9}\//.test(keyword) &&
        !/^https?:\/\//i.test(keyword) &&
        !/@/.test(keyword) &&
        !/^\d{2,}(?:[-–]\d+)?$/.test(keyword),
    )
    .slice(0, 10);
}

const TITLE_NOISE_PATTERN =
  /^(doi|http|https|abstract|introduction|keywords?|key\s+words|关键词|关键字|index\s+terms?|journal|volume|vol\.?|issue|number|received|accepted|published|correspondence|corresponding|affiliation|affiliations|author|authors|email|e-mail|open access|creative commons|©|copyright|page|article|research article|review article|original article|letter|this article|how to cite|cite this|suggested citation|all rights reserved|contents lists|available online|sciencedirect|arxiv)\b/i;

function looksLikeBoilerplateTitle(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (
    /^(?:provided proper attribution|reproduce the tables and figures|solely for use in journalistic or|scholarly works|permission to reproduce|this is an open access article|this article is available|this article is licensed)/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:hereby grants?|grants? permission|permission to reproduce|all rights reserved|licensed under|under the terms of|creative commons attribution|please cite this article|how to cite this article|submitted for publication|accepted for publication|received for publication|©\s*\d{4})\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

const AUTHOR_OR_AFFILIATION_PATTERN =
  /\b(?:university|institute|department|school|hospital|laboratory|lab|college|center|centre|academy|affiliation|email|e-mail|@)\b/i;

function titleLooksLikeFileName(value?: string): boolean {
  const text = value?.trim() ?? "";
  if (!text) return true;
  if (/[\\/]/.test(text) || /\.\w{2,6}$/.test(text)) return true;
  if (/^[\w-]+$/.test(text) && /[0-9]/.test(text)) return true;
  return false;
}

export function isWeakPaperTitle(value?: string): boolean {
  const text = value?.trim() ?? "";
  if (!text || titleLooksLikeFileName(text)) return true;
  if (looksLikeBoilerplateTitle(text)) return true;
  return /^(untitled|microsoft\s+word|word\s+document|document|paper|draft|final|copy|scan|image)\b/i.test(text);
}

function looksLikeJournalHeader(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^(?:volume|vol\.?|issue|number|doi|issn)\b/i.test(text)) return true;
  const known = text.match(
    /^(?:The\s+)?(?:Nature Communications|Nature Medicine|Nature|Science Advances|Science|Cell Reports?|Cell|The Lancet|Lancet|BMJ|JAMA|New England Journal of Medicine|PNAS|Proceedings of the National Academy of Sciences|eLife|PLoS ONE|PLOS ONE|Physical Review Letters?|Applied Physics Letters?)\b/i,
  );
  if (known && text.split(/\s+/).filter(Boolean).length <= 12) return true;
  const journalWord = text.match(
    /\b(?:Journal|Transactions|Reviews?|Letters?|Proceedings|Bulletin|Reports?|Annals)\b/i,
  );
  return Boolean(journalWord) && text.split(/\s+/).filter(Boolean).length <= 12;
}

function looksLikeAuthorList(value: string): boolean {
  const text = value.trim();
  if (!text || /\bet al\.?\b/i.test(text)) return true;
  const segments = text.split(/\s*,\s*/).filter(Boolean);
  return (
    segments.length >= 3 &&
    segments.every((segment) =>
      /^[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,2}$/.test(segment.trim()),
    )
  );
}

function cleanTitleCandidate(value: string): string {
  return rejoinHyphenatedWords(value.replace(/\s+/g, " "))
    .replace(/^[•·\-–—]\s*/, "")
    .replace(/[.…;:]+$/, "")
    .trim();
}

function isPlausibleTitleLine(line: string): boolean {
  const text = line.trim();
  if (!text || text.length < 4 || text.length > 240) return false;
  if (looksLikeBoilerplateTitle(text)) return false;
  if (TITLE_NOISE_PATTERN.test(text)) return false;
  if (looksLikeJournalHeader(text) || looksLikeAuthorList(text)) return false;
  if (/^[0-9]+(\s*[.,-]\s*[0-9]+)*$/.test(text)) return false;
  if (AUTHOR_OR_AFFILIATION_PATTERN.test(text) && /[,\d@]/.test(text)) return false;
  if (/[\u4e00-\u9fff]/.test(text)) {
    return text.length >= 4 && text.length <= 120;
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return words >= 2 && words <= 25;
}

export function inferTitleFromText(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (const line of lines) {
    if (
      /^(abstract|introduction|keywords?|key\s+words|关键词|关键字|index\s+terms?|references|conclusion)\b/i.test(
        line,
      )
    ) {
      break;
    }
    if (isPlausibleTitleLine(line)) candidates.push(line);
    if (candidates.length >= 6) break;
  }
  return candidates.length ? cleanTitleCandidate(candidates[0]) : undefined;
}

interface ScoredBlock {
  block: PaperMetadataBlockInput;
  text: string;
  fontSize: number;
  top: number;
  index: number;
}

function blockTitleBaseScore(
  text: string,
  kind: string | undefined,
  fontSize: number,
  top: number,
  height: number,
): number {
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  let score = 0;
  if (kind === "heading") score += 26;
  score += Math.max(0, Math.min(36, fontSize - 8)) * 2.2;
  if (Number.isFinite(top) && height > 0) {
    score += Math.max(0, 1 - top / height) * 14;
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (hasCjk) {
    if (text.length >= 4 && text.length <= 90) score += 10;
  } else if (words >= 3 && words <= 18) {
    score += 8 + Math.min(6, Math.max(0, words - 3) * 0.5);
  } else if (words >= 2 && words <= 25) {
    score += 3;
  }
  if (/[.!?]$/.test(text)) score -= 8;
  if (
    /^(abstract|introduction|conclusion|references|materials|methods|results|discussion|background|keywords?|key\s+words)\b/i.test(
      text,
    )
  ) {
    score -= 100;
  }
  if (looksLikeBoilerplateTitle(text)) score -= 100;
  if (AUTHOR_OR_AFFILIATION_PATTERN.test(text) && /[,@\d]/.test(text)) {
    score -= 30;
  }
  if (looksLikeJournalHeader(text)) score -= 100;
  return score;
}

export function inferTitleFromBlocks(
  blocks?: PaperMetadataBlockInput[],
  pageHeight?: number,
): string | undefined {
  if (!blocks?.length) return undefined;
  const height = Number(pageHeight) > 0 ? Number(pageHeight) : 800;
  const scored = blocks
    .map((block, index) => {
      const text = cleanTitleCandidate(block.text ?? "");
      const fontSize = Number(block.fontSize) || 0;
      const top = Number(block.top);
      if (
        block.kind === "caption" ||
        block.kind === "table" ||
        block.kind === "equation"
      ) {
        return undefined;
      }
      if (!isPlausibleTitleLine(text)) return undefined;
      return {
        block,
        text,
        fontSize,
        top: Number.isFinite(top) ? top : Number.POSITIVE_INFINITY,
        index,
      };
    })
    .filter((item): item is ScoredBlock => Boolean(item))
    .sort((a, b) => a.top - b.top || a.index - b.index);

  let bestText: string | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let start = 0; start < scored.length; start += 1) {
    let combined = scored[start].text;
    let maxFont = scored[start].fontSize;
    let minTop = scored[start].top;
    let hasHeading = scored[start].block.kind === "heading";
    const candidates = [combined];
    let last = scored[start];
    for (let next = start + 1; next < scored.length; next += 1) {
      const candidate = scored[next];
      if (
        !Number.isFinite(candidate.top) ||
        !Number.isFinite(last.top) ||
        candidate.top - last.top < 0 ||
        candidate.top > height * 0.72
      ) {
        break;
      }
      const gap = candidate.top - last.top;
      const maxOfPair = Math.max(maxFont, candidate.fontSize);
      const minOfPair = Math.min(maxFont, candidate.fontSize);
      const wordCount =
        combined.split(/\s+/).filter(Boolean).length +
        candidate.text.split(/\s+/).filter(Boolean).length;
      const joinable =
        gap <= Math.max(22, maxOfPair * 1.3) &&
        Math.abs(maxFont - candidate.fontSize) <= 3 &&
        maxOfPair <= Math.max(6, minOfPair * 1.25) &&
        !/[.!?]$/.test(last.text) &&
        wordCount <= 30 &&
        !looksLikeJournalHeader(candidate.text) &&
        !looksLikeAuthorList(candidate.text);
      if (!joinable) break;
      combined = `${combined} ${candidate.text}`;
      maxFont = Math.max(maxFont, candidate.fontSize);
      minTop = Math.min(minTop, candidate.top);
      hasHeading = hasHeading || candidate.block.kind === "heading";
      candidates.push(combined);
      last = candidate;
    }
    for (const text of candidates) {
      const runBonus = text !== scored[start].text ? 6 : 0;
      const score = blockTitleBaseScore(
        text,
        hasHeading ? "heading" : undefined,
        maxFont,
        minTop,
        height,
      ) + runBonus;
      if (
        score > bestScore ||
        (score === bestScore && (!bestText || text.length > bestText.length))
      ) {
        bestScore = score;
        bestText = text;
      }
    }
  }
  return bestScore > 0 ? bestText : undefined;
}

const PUBLISHED_IN_PATTERN =
  /(?:(?:published|accepted|submitted)\s+for\s+publication\s+in\s+(?:the\s+)?([A-Z][A-Za-z0-9&'’\- ]{2,120})|(?:published|appears|featured|printed)\s+in\s+(?:the\s+)?([A-Z][A-Za-z0-9&'’\- ]{2,120}))/i;

const KNOWN_JOURNAL_PATTERN =
  /(?:^|\n)\s*((?:The\s+)?(?:Lancet|BMJ|JAMA|New England Journal of Medicine|Nature|Science Advances|Science|Cell|eLife|PLoS ONE|PLOS ONE|PNAS|Proceedings of the National Academy of Sciences)\b[^\n]{0,90})/im;

const JOURNAL_LINE_PATTERN =
  /(?:^|\n)\s*((?:The\s+)?[A-Z][A-Za-z0-9&'’\- ]{2,90}\b(?:Journal|Transactions|Proceedings|Reviews?|Letters?|Bulletin|Annals|Reports?|Communications|Quarterly|Magazine)\b[^\n]{0,110})/im;

const JOURNAL_STOP_PATTERN =
  /\s+(?:vol(?:ume)?\.?\s*\d+|issue\s*\d+|pp?\.?\s*\d+|doi\s*[:=]|issn\s*[:=]|received|accepted|submitted|published online|©|copyright)\b/i;

const JOURNAL_ACRONYM_PATTERN =
  /^(?:IEEE|ACM|SIAM|PLOS|PNAS|AIP|APS|IOP|OSA|SPIE|ASME|ASCE|AAAI|IJCAI|CVPR|ICCV|ECCV|ICLR|ICML|NeurIPS|NLP|AI|ML|DL|JMLR|TNNLS|TEVC|TETCI|ONE)$/i;

function normalizeJournalName(value: string): string {
  const text = value.trim();
  if (!text || text !== text.toUpperCase() || !/[A-Za-z]/.test(text)) return text;
  const stopWords = new Set([
    "of",
    "in",
    "on",
    "for",
    "and",
    "the",
    "a",
    "an",
    "to",
    "with",
    "by",
    "from",
    "at",
  ]);
  return text
    .split(/\s+/)
    .map((word, index) => {
      const clean = word.replace(/[^A-Za-z0-9&'’.\-]/g, "");
      if (JOURNAL_ACRONYM_PATTERN.test(clean)) return word;
      const lower = clean.toLowerCase();
      if (index > 0 && stopWords.has(lower)) return lower;
      return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : word;
    })
    .join(" ");
}

function cleanJournalName(value: string): string {
  return normalizeJournalName(value
    .replace(/\s+/g, " ")
    .replace(/[《》「」]/g, "")
    .replace(
      /\s*[,;]\s*(?:20\d{2}|vol(?:ume)?\.?\s*\d+|issue\s*\d+|pp?\.?\s*\d+|doi\s*[:=]|issn\s*[:=]|received|accepted|submitted|published online|©|copyright)\b.*$/i,
      "",
    )
    .replace(JOURNAL_STOP_PATTERN, "")
    .replace(
      /\s*[.,]\s+(?:This|The|Author|Copyright|©|All rights reserved|Available|DOI|ISSN)\b.*$/i,
      "",
    )
    .replace(/[.,;:]+$/, "")
    .trim());
}

export function extractJournalFromText(text: string): string | undefined {
  const head = text.replace(/\r/g, "").slice(0, 10000);
  const published = head.match(PUBLISHED_IN_PATTERN);
  const publishedJournal = published?.[1] ?? published?.[2];
  if (publishedJournal) return cleanJournalName(publishedJournal);
  const known = head.match(KNOWN_JOURNAL_PATTERN);
  if (known?.[1]) return cleanJournalName(known[1]);
  const line = head.match(JOURNAL_LINE_PATTERN);
  if (line?.[1]) return cleanJournalName(line[1]);
  const chinese = head.match(
    /(?:发表于|刊于|期刊名称|杂志)[：:\s]*([《「]?[^《》\n，。]{2,80}[》」]?)/,
  );
  if (chinese?.[1]) return cleanJournalName(chinese[1]);
  return undefined;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(candidate: string, query: string): number {
  const candidateNormalized = normalizeTitle(candidate);
  const queryNormalized = normalizeTitle(query);
  if (!candidateNormalized || !queryNormalized) return 0;
  if (candidateNormalized === queryNormalized) return 1;
  const queryWords = queryNormalized.split(" ").filter((word) => word.length >= 2);
  const candidateWords = new Set(candidateNormalized.split(" "));
  if (!queryWords.length) return 0;
  const matched = queryWords.filter((word) => candidateWords.has(word)).length;
  const missing = queryWords.length - matched;
  return Math.max(0, matched / queryWords.length - missing * 0.06);
}

function chooseBestMatch<T extends { title?: unknown }>(
  items: T[],
  query: string,
): T | undefined {
  if (!items.length) return undefined;
  let best: T | undefined;
  let bestScore = -1;
  for (const item of items) {
    const title = firstString(item.title);
    if (!title) continue;
    const score = titleSimilarity(title, query);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best ?? items[0];
}

async function fetchCrossref(
  fetcher: typeof fetch,
  input: PaperMetadataLookupInput,
  queryTitle: string | undefined,
): Promise<{
  title?: string;
  journal?: string;
  issn?: string;
  keywords?: string[];
  score: number;
}> {
  const doi = extractDoi(input.text ?? "");
  if (doi) {
    const data = (await fetchJson(
      fetcher,
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    )) as CrossrefResponse;
    const item = data.message;
    if (!item) return { score: 0 };
    return {
      title: firstString(item.title),
      journal: firstString(item["container-title"]),
      issn: firstString(item.ISSN),
      keywords: toStringArray(item.subject),
      score: 1,
    };
  }
  const query = queryTitle?.trim();
  if (!query) return { score: 0 };
  const data = (await fetchJson(
    fetcher,
    `https://api.crossref.org/works?query.title=${encodeURIComponent(query)}&rows=5&select=DOI,title,container-title,ISSN,subject`,
  )) as CrossrefResponse;
  const items = data.message?.items ?? [];
  const item = chooseBestMatch(items, query);
  if (!item) return { score: 0 };
  const title = firstString(item.title);
  return {
    title,
    journal: firstString(item["container-title"]),
    issn: firstString(item.ISSN),
    keywords: toStringArray(item.subject),
    score: title ? titleSimilarity(title, query) : 0,
  };
}

async function fetchOpenAlexSource(
  fetcher: typeof fetch,
  issn: string,
): Promise<OpenAlexSource | undefined> {
  const data = (await fetchJson(
    fetcher,
    `https://api.openalex.org/sources?filter=issn:${encodeURIComponent(issn)}&per-page=5`,
  )) as { results?: OpenAlexSource[] };
  return data.results?.find(
    (source) => source.display_name || source.summary_stats,
  );
}

async function fetchOpenAlex(
  fetcher: typeof fetch,
  doi?: string,
  issn?: string,
  queryTitle?: string,
): Promise<{
  source?: OpenAlexSource;
  keywords?: string[];
  title?: string;
  titleScore: number;
}> {
  let source: OpenAlexSource | undefined;
  let keywords: string[] = [];
  let title: string | undefined;
  let titleScore = 0;
  if (doi) {
    try {
      const data = (await fetchJson(
        fetcher,
        `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
      )) as OpenAlexWork;
      if (data.primary_location?.source || data.keywords) {
        source = data.primary_location?.source;
        keywords = toStringArray(data.keywords);
        titleScore = 1;
      }
    } catch {
      // DOI 精确查询失败时继续尝试标题搜索
    }
  }
  if (issn && !source?.summary_stats?.["2yr_mean_citedness"]) {
    try {
      const issnSource = await fetchOpenAlexSource(fetcher, issn);
      if (issnSource) source = issnSource;
    } catch {
      // ISSN 查询失败时保留 DOI 或标题搜索得到的期刊
    }
  }
  const query = queryTitle?.trim();
  if (!query) return { source, keywords, title, titleScore };
  try {
    const data = (await fetchJson(
      fetcher,
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`,
    )) as OpenAlexResponse;
    const item = chooseBestMatch(data.results ?? [], query);
    if (!item) return { source, keywords, title, titleScore };
    title = firstString(item.title);
    if (!source) source = item.primary_location?.source;
    if (!keywords.length) keywords = toStringArray(item.keywords);
    titleScore = title ? titleSimilarity(title, query) : 0;
  } catch {
    // 标题搜索失败时不影响已得到的 DOI/ISSN 结果
  }
  return {
    source,
    keywords,
    title,
    titleScore,
  };
}

function impactFactorFromSource(source?: OpenAlexSource): string | undefined {
  const raw = source?.summary_stats?.["2yr_mean_citedness"];
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value.toFixed(2);
}

export async function lookupPaperMetadata(
  input: PaperMetadataLookupInput,
  fetcher: typeof fetch = fetch,
): Promise<PaperMetadataPatch> {
  const text = (input.text ?? "").slice(0, MAX_TEXT_CHARS);
  const metadataTitle = isWeakPaperTitle(input.metadataTitle)
    ? undefined
    : input.metadataTitle?.trim();
  const localKeywords = extractKeywordsFromText(text);
  const localJournal = extractJournalFromText(text);
  let inferredTitle =
    metadataTitle ||
    inferTitleFromBlocks(input.blocks, input.pageHeight) ||
    inferTitleFromText(text);
  if (
    inferredTitle &&
    localJournal &&
    normalizeTitle(inferredTitle) === normalizeTitle(localJournal)
  ) {
    inferredTitle = undefined;
  }
  const queryTitle = inferredTitle || input.title?.trim() || metadataTitle;
  const result: PaperMetadataPatch = {};
  if (inferredTitle) result.title = inferredTitle;
  if (localKeywords.length) result.keywords = localKeywords;

  let journal: string | undefined;
  let issn: string | undefined;
  let crossrefKeywords: string[] = [];
  let crossrefTitle: string | undefined;
  let crossrefScore = 0;
  let openAlexSource: OpenAlexSource | undefined;
  let openAlexKeywords: string[] = [];
  let openAlexTitle: string | undefined;
  let openAlexScore = 0;

  try {
    const crossref = await fetchCrossref(fetcher, input, queryTitle);
    crossrefTitle = crossref.title;
    crossrefScore = crossref.score;
    journal = crossref.journal;
    issn = crossref.issn;
    crossrefKeywords = crossref.keywords ?? [];
  } catch {
    // Crossref 不可用时继续使用本地解析结果
  }

  try {
    const openAlex = await fetchOpenAlex(
      fetcher,
      extractDoi(text),
      issn,
      queryTitle,
    );
    openAlexSource = openAlex.source;
    openAlexKeywords = openAlex.keywords ?? [];
    openAlexTitle = openAlex.title;
    openAlexScore = openAlex.titleScore;
  } catch {
    // OpenAlex 不可用时不影响论文保存
  }

  const hasLocalTitle = Boolean(inferredTitle);
  const crossrefTitleToUse =
    crossrefTitle && crossrefScore >= 0.3
      ? crossrefTitle
      : undefined;
  const openAlexTitleToUse =
    !crossrefTitleToUse &&
    openAlexTitle &&
    openAlexScore >= 0.3
      ? openAlexTitle
      : undefined;
  if (
    !metadataTitle &&
    (!hasLocalTitle ||
      titleLooksLikeFileName(input.title) ||
      Math.max(crossrefScore, openAlexScore) >= 0.6)
  ) {
    if (crossrefTitleToUse) result.title = crossrefTitleToUse;
    else if (openAlexTitleToUse) result.title = openAlexTitleToUse;
  }
  if (journal) result.journal = journal;
  else if (localJournal) result.journal = localJournal;
  if (!result.keywords?.length && crossrefKeywords.length) {
    result.keywords = crossrefKeywords;
  }
  if (!result.keywords?.length && openAlexKeywords.length) {
    result.keywords = openAlexKeywords;
  }
  if (!result.journal && openAlexSource?.display_name) {
    result.journal = openAlexSource.display_name;
  }
  const impactFactor = impactFactorFromSource(openAlexSource);
  if (impactFactor) result.impactFactor = impactFactor;
  return result;
}
