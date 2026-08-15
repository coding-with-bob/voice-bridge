/**
 * Writer for the C2 spoken ledger. Append-only, one line per utterance, and — the part
 * that matters — only ever called after playback has actually succeeded.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SpokenLogEntrySchema,
  spokenLogPathFor,
  type SpokenLogEntry,
} from "../contracts/spoken-log.ts";

/** Appends one entry and returns the file it landed in. */
export function appendSpokenLine(homeDir: string, entry: SpokenLogEntry, when: Date): string {
  const validated = SpokenLogEntrySchema.parse(entry);
  const path = spokenLogPathFor(homeDir, when);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
  return path;
}
