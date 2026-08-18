/**
 * Writer for the C7 interruption log — `~/bob/logs/interruptions.jsonl`, one line per
 * barge-in that actually killed something.
 *
 * It records only the *unheard* side. What was heard is the C2 ledger's business, and
 * the two must not disagree: the sentence playing at the moment of the kill has no
 * ledger line and heads `interrupted_text` instead.
 */
import { appendFileSync, mkdirSync } from "node:fs";
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
