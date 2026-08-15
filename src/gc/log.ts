/**
 * Writer for the gc action log. Mirrors the decision log: append-only, validated on the way
 * in, and written for both real sweeps and dry runs — what a proposed sweep would have
 * touched is exactly what you want to read before running it for real.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GcLogEntrySchema, type GcLogEntry } from "../contracts/gc-log.ts";

export function appendGcEntry(gcLogPath: string, entry: GcLogEntry): void {
  const validated = GcLogEntrySchema.parse(entry);
  mkdirSync(dirname(gcLogPath), { recursive: true });
  appendFileSync(gcLogPath, `${JSON.stringify(validated)}\n`, "utf8");
}
