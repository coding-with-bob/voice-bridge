/**
 * Prosody: emphasis and pauses, rendered for the engine that will speak the line.
 *
 * `plain` is the engine-neutral rendering — that is what the C2 ledger records and what
 * `--json` reports, so the log stays a readable chronicle instead of a pile of control codes.
 */
import type { Engine } from "../contracts/spoken-log.ts";

export type ProsodyTarget = Engine | "plain";

const BOLD = /\*\*(.+?)\*\*/g;
const EMPHASIS = /\*([^*\s][^*]*?)\*/g;
const ELLIPSIS = /\.\.\.|…/g;

/** macOS `say` reads `[[...]]` as embedded commands — strip brackets before adding our own. */
const SAY_COMMAND_BRACKETS = /[[\]]/g;
const SAY_PAUSE_MS = 350;

export function applyProsody(text: string, target: ProsodyTarget): string {
  if (target === "say") {
    return text
      .replace(SAY_COMMAND_BRACKETS, "")
      .replace(BOLD, "[[emph +]]$1[[emph -]]")
      .replace(EMPHASIS, "[[emph +]]$1[[emph -]]")
      .replace(ELLIPSIS, `[[slnc ${SAY_PAUSE_MS}]]`);
  }
  // ElevenLabs renders emphasis and pauses from the sentence itself; markers would be read out.
  return stripEmphasisMarkers(text);
}

export function stripEmphasisMarkers(text: string): string {
  return text.replace(BOLD, "$1").replace(EMPHASIS, "$1");
}
