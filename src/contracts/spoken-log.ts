/**
 * C2 — the spoken log.
 *
 * `~/bob/spoken/YYYY-MM-DD.jsonl`, one line per utterance, append-only, grouped by
 * local calendar day. It records only what was actually heard: `bobsay` appends a
 * line after successful playback, never before.
 *
 * There is deliberately no last-speaker pointer file. "Most recent interaction" is
 * derived at read time from this log plus the C5 decision log — one source of truth,
 * no cache to drift.
 */
import { z } from "zod";
import { join } from "node:path";

export const EngineSchema = z.enum(["elevenlabs", "say"]);
export type Engine = z.infer<typeof EngineSchema>;

export const SpokenLogEntrySchema = z.object({
  /** ISO-8601 timestamp of the moment playback finished. */
  ts: z.iso.datetime(),
  /** The session that spoke, or null for sessionless calls such as router acks. */
  session_id: z.string().min(1).nullable(),
  /** The text as it was actually spoken (cleaned, prosody applied). */
  text: z.string(),
  /** Engine-specific voice identifier (a `say` voice name or an ElevenLabs voice id). */
  voice: z.string(),
  engine: EngineSchema,
});
export type SpokenLogEntry = z.infer<typeof SpokenLogEntrySchema>;

/** Path of the daily log file an utterance spoken at `when` belongs to. */
export function spokenLogPathFor(homeDir: string, when: Date): string {
  return join(homeDir, "spoken", `${localDayStamp(when)}.jsonl`);
}

/** `YYYY-MM-DD` in local time — the day the human actually heard the sentence. */
export function localDayStamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/**
 * Parse one log line, returning null for anything unreadable.
 * Readers must tolerate corrupt lines: the log is appended to by concurrent
 * processes and a partial write must never break a reader.
 */
export function parseSpokenLogLine(line: string): SpokenLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = SpokenLogEntrySchema.safeParse(raw);
  return result.success ? result.data : null;
}
