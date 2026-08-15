/**
 * The C5 decision log: every routing invocation, whatever the outcome.
 *
 * It is two things at once. A forensic record — what the model saw, what it answered, how
 * long it took, whether the answer was carried out. And the dispatch half of C2's recency
 * derivation: the `executed` entries say who was last spoken *to*, the spoken ledger says
 * who last spoke. Between them there is no pointer file to drift.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DecisionLogEntrySchema, type DecisionLogEntry } from "../contracts/decision.ts";

export interface DispatchEvent {
  session_id: string;
  ts: string;
}

export function appendDecisionEntry(logPath: string, entry: DecisionLogEntry): void {
  const validated = DecisionLogEntrySchema.parse(entry);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(validated)}\n`, "utf8");
}

export function readDecisionEntries(
  logPath: string,
  options: { limit?: number },
): DecisionLogEntry[] {
  if (!existsSync(logPath)) return [];
  let lines: string[];
  try {
    lines = readFileSync(logPath, "utf8").split("\n");
  } catch {
    return [];
  }

  const entries: DecisionLogEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = DecisionLogEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A partial write from a killed router: skip the line, keep the log.
    }
  }
  return options.limit === undefined ? entries : entries.slice(-options.limit);
}

/** The dispatches that actually landed — one half of the derived "most recent interaction". */
export function dispatchEvents(entries: DecisionLogEntry[]): DispatchEvent[] {
  return entries
    .filter((entry) => entry.executed && entry.target_session_id !== null)
    .map((entry) => ({ session_id: entry.target_session_id!, ts: entry.ts }));
}
