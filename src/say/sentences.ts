/**
 * Sentence splitting for the chunked playback pipeline (M1 of the barge-in plan).
 *
 * Deliberately simple: split after `.` / `!` / `?` / `…` followed by whitespace, except
 * after a single-letter initial. Numbers (`3.5`) never match because no whitespace follows
 * the dot. Everything subtler is out of scope on purpose — a wrong split costs a slightly
 * odd pause, not a wrong meaning.
 */

/** One or more terminators, remembered whitespace after — the only boundary we honour. */
const BOUNDARY = /[.!?…]+(?=\s)/gu;

/** `E.` in `E. W. Dijkstra`: a lone letter before the dot, nothing word-like before it. */
const SINGLE_LETTER_INITIAL = /(?:^|\s)\p{L}$/u;

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (const match of text.matchAll(BOUNDARY)) {
    const boundaryEnd = match.index + match[0].length;
    const isInitial =
      match[0] === "." && SINGLE_LETTER_INITIAL.test(text.slice(start, match.index));
    if (isInitial) continue;
    pushTrimmed(sentences, text.slice(start, boundaryEnd));
    start = boundaryEnd;
  }
  pushTrimmed(sentences, text.slice(start));

  return sentences;
}

function pushTrimmed(sentences: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed !== "") sentences.push(trimmed);
}
