/**
 * The dialogue, reassembled at read time.
 *
 * The router decides better when it sees the conversation the way the person experienced
 * it: what was asked, where it went, what came back, in order. A standing router session
 * would get this by accumulating state — and become a second copy of the truth that drifts,
 * with a compaction problem on top. These are the same exchanges derived fresh on every
 * invocation from the two event logs: bounded by construction, nothing to drift, and a
 * crash costs nothing.
 */
import type { DecisionLogEntry } from "../contracts/decision.ts";
import type { SpokenLogEntry } from "../contracts/spoken-log.ts";

export interface Exchange {
  minutes_ago: number;
  utterance: string;
  action: "continue" | "new" | "clarify" | "lookup_ledger";
  target_session_id: string | null;
  /** What came back: the target's first spoken line after the dispatch, or the clarify question. */
  reply: string | null;
}

/** Enough dialogue to carry a thread, few enough lines to stay prompt-sized. */
const DEFAULT_LIMIT = 6;
const MAX_TEXT = 110;

export function buildExchanges(input: {
  decisions: DecisionLogEntry[];
  spoken: SpokenLogEntry[];
  now: Date;
  limit?: number;
}): Exchange[] {
  const limit = input.limit ?? DEFAULT_LIMIT;

  return input.decisions
    .filter((entry) => entry.decision !== null)
    .slice(-limit)
    .map((entry) => {
      const decision = entry.decision!;
      const dispatchedAt = Date.parse(entry.ts);

      const reply =
        decision.action === "clarify"
          ? decision.question
          : entry.target_session_id === null
            ? null
            : (input.spoken.find(
                (line) =>
                  line.session_id === entry.target_session_id &&
                  Date.parse(line.ts) >= dispatchedAt,
              )?.text ?? null);

      return {
        minutes_ago: Math.max(0, Math.floor((input.now.getTime() - dispatchedAt) / 60_000)),
        utterance: truncate(entry.utterance),
        action: decision.action,
        target_session_id: entry.target_session_id,
        reply: reply === null ? null : truncate(reply),
      };
    });
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_TEXT ? `${single.slice(0, MAX_TEXT)}…` : single;
}
