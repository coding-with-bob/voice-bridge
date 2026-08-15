/**
 * Clean-for-speech: turn whatever a session wrote into something a person can hear.
 *
 * Emphasis markers (`**bold**`, `*emphasis*`) deliberately survive this step — prosody
 * consumes them next. Underscores are left alone: in this ecosystem they are identifier
 * characters (`route_decisions.jsonl`), not italics.
 *
 * Cleaning is a pure transform and never shortens content. The length cap is policy,
 * not cleaning — `capForSpeech` below — and the pipeline that applies it is responsible
 * for saying so out loud (C1: a cut is warned about, never silent).
 */

/**
 * Runaway protection, not a format rule: whole spoken answers — a recap, an explanation —
 * must fit. At ElevenLabs speech rate this is roughly five minutes of audio; anything past
 * it is almost certainly a document pasted into a mouth. (The 600-char era treated this as
 * a summary-length rule and silently cut real content mid-sentence; 2026-08-15.)
 */
export const MAX_SPOKEN_CHARS = 5_000;

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

  return lines
    .map((line, index) => (index < lines.length - 1 && !ENDS_A_CLAUSE.test(line) ? `${line}.` : line))
    .join(" ");
}

/** Cut at a word boundary, mark the cut, and report how many characters fell. */
export function capForSpeech(text: string): { text: string; dropped: number } {
  if (text.length <= MAX_SPOKEN_CHARS) return { text, dropped: 0 };
  const head = text.slice(0, MAX_SPOKEN_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut = (lastSpace > 0 ? head.slice(0, lastSpace) : head).replace(/[\s.,;:]+$/, "");
  return { text: `${cut}…`, dropped: text.length - cut.length };
}

function stripLinePrefixes(line: string): string {
  let result = line;
  for (const prefix of LINE_PREFIXES) result = result.replace(prefix, "");
  return result;
}
