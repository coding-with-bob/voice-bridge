/**
 * Writer for the C7 interruption log — `~/bob/logs/interruptions.jsonl`, one line per
 * barge-in that actually killed something.
 *
 * It records only the *unheard* side. What was heard is the C2 ledger's business, and
 * the two must not disagree: the sentence playing at the moment of the kill has no
 * ledger line and heads `interrupted_text` instead.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  InterruptionRecordSchema,
  interruptionsLogPath,
  type InterruptionRecord,
} from "../contracts/playback.ts";

/** Appends one record and returns the file it landed in. */
export function appendInterruption(homeDir: string, record: InterruptionRecord): string {
  const validated = InterruptionRecordSchema.parse(record);
  const path = interruptionsLogPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
  return path;
}

/**
 * The most recent barge-in, or null when there is none to be had. Reads from the end and
 * tolerates unreadable lines: hush appends from a short-lived process while the router
 * reads, and a partial write must not cost the reader the record before it.
 */
export function readLatestInterruption(homeDir: string): InterruptionRecord | null {
  let contents: string;
  try {
    contents = readFileSync(interruptionsLogPath(homeDir), "utf8");
  } catch {
    return null;
  }
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    try {
      const parsed = InterruptionRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON at all; keep walking backwards.
    }
  }
  return null;
}
