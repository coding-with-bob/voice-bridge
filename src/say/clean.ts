/**
 * Clean-for-speech: turn whatever a session wrote into something a person can hear.
 *
 * Emphasis markers (`**bold**`, `*emphasis*`) deliberately survive this step — prosody
 * consumes them next. Underscores are left alone: in this ecosystem they are identifier
 * characters (`route_decisions.jsonl`), not italics.
 */

/** Longer than this and it stops being a spoken summary. Cut at a word boundary, marked. */
export const MAX_SPOKEN_CHARS = 600;

const FENCED_BLOCK = /```[\s\S]*?```/g;
const DANGLING_FENCE = /```[\s\S]*$/;
const INLINE_CODE = /`([^`]*)`/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

const HORIZONTAL_RULE = /^\s*([-*_])\1{2,}\s*$/;
const LINE_PREFIXES = [
  /^\s*>+\s*/, // blockquote
  /^\s*#{1,6}\s+/, // heading
  /^\s*[-*+]\s+/, // bullet
  /^\s*\d+[.)]\s+/, // numbered item
];

const ENDS_A_CLAUSE = /[.!?:;,…]$/;

export function cleanForSpeech(raw: string): string {
  const withoutCode = raw.replace(FENCED_BLOCK, "\n").replace(DANGLING_FENCE, "\n");
  const withoutMarkup = withoutCode
    .replace(INLINE_CODE, "$1")
    .replace(MARKDOWN_LINK, "$1")
    .replace(PICTOGRAPHS, "");

  const lines = withoutMarkup
    .split("\n")
    .filter((line) => !HORIZONTAL_RULE.test(line))
    .map(stripLinePrefixes)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");

  const joined = lines
    .map((line, index) => (index < lines.length - 1 && !ENDS_A_CLAUSE.test(line) ? `${line}.` : line))
    .join(" ");

  return capLength(joined);
}

function stripLinePrefixes(line: string): string {
  let result = line;
  for (const prefix of LINE_PREFIXES) result = result.replace(prefix, "");
  return result;
}

function capLength(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const head = text.slice(0, MAX_SPOKEN_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s.,;:]+$/, "")}…`;
}
