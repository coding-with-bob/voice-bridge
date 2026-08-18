/**
 * C7 — playback queue metadata, interruption record, pause protocol.
 *
 * Three parts, all under the state home:
 *   - ticket bodies in `state/playback/` carry who is speaking what, so `bob hush` can
 *     kill the right playback and record what fell silent without asking anyone;
 *   - `logs/interruptions.jsonl` records the *unheard* side of every barge-in — the heard
 *     side is the C2 ledger's job, and the two must never disagree;
 *   - `state/playback/pause.json` mutes ordinary playback from PTT press until the
 *     router's acknowledgement has been spoken, with a hard deadline so a crashed
 *     roundtrip cannot mute the machine.
 */
import { z } from "zod";
import { join } from "node:path";

export const TicketBodySchema = z.object({
  /** The session speaking, or null for sessionless calls such as router acks. */
  session_id: z.string().min(1).nullable(),
  /** Shared by all chunks of one answer; null when the caller supplied none. */
  answer_id: z.string().min(1).nullable(),
  /** What this ticket still intends to speak — rewritten at every sentence boundary. */
  remaining_text: z.string(),
});
export type TicketBody = z.infer<typeof TicketBodySchema>;

/** One line per barge-in that actually killed something. Stores only the unheard side. */
export const InterruptionRecordSchema = z.object({
  ts: z.iso.datetime(),
  session_id: z.string().min(1).nullable(),
  answer_id: z.string().min(1).nullable(),
  /** The holder's remaining_text: the unspoken tail, starting at the interrupted sentence. */
  interrupted_text: z.string(),
  /** remaining_text of same-answer queued tickets that were removed unplayed. */
  unplayed_texts: z.array(z.string()),
});
export type InterruptionRecord = z.infer<typeof InterruptionRecordSchema>;

/**
 * What a routing decision records about the barge-in it was made under (C5): the record
 * without its payload. The unplayed chunks are evidence for the session, not for the
 * routing forensics — a digest, not a copy.
 */
export const InterruptionDigestSchema = InterruptionRecordSchema.omit({ unplayed_texts: true });
export type InterruptionDigest = z.infer<typeof InterruptionDigestSchema>;

/** While a non-expired marker exists, only pause-exempt tickets may hold the lock. */
export const PauseMarkerSchema = z.object({
  ts: z.iso.datetime(),
  /** Hard expiry — a crashed roundtrip must not mute the machine. Expiry is loud. */
  deadline: z.iso.datetime(),
});
export type PauseMarker = z.infer<typeof PauseMarkerSchema>;

/** Default distance from pause to its hard deadline. */
export const PAUSE_DEADLINE_MS = 180_000;

/** The FIFO lock directory playback serializes through. */
export function playbackLockDir(homeDir: string): string {
  return join(homeDir, "state", "playback");
}

export function pauseMarkerPath(homeDir: string): string {
  return join(playbackLockDir(homeDir), "pause.json");
}

export function interruptionsLogPath(homeDir: string): string {
  return join(homeDir, "logs", "interruptions.jsonl");
}

/**
 * Parse a ticket body, returning null for anything unreadable — including the old
 * empty-body format. A metadata-less ticket is still a valid queue member: kill-eligible
 * as holder, never matched by answer filters. It must not wedge the queue.
 */
export function parseTicketBody(raw: string): TicketBody | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = TicketBodySchema.safeParse(parsed);
  return result.success ? result.data : null;
}
