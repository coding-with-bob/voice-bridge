/**
 * The `bob gc` action log, `~/bob/logs/gc.jsonl`.
 *
 * Not one of the six pinned contracts, but it is a seam all the same: `bob gc` writes it
 * (M5) and `bob log` reads it (M4), so its shape is fixed here rather than discovered twice.
 *
 * `stopped` records what happened, `dry_run` records whether it was ever going to. A dry run
 * is logged too — knowing what a proposed sweep would have touched is worth a line.
 */
import { z } from "zod";

export const GcLogEntrySchema = z.object({
  ts: z.iso.datetime(),
  session_id: z.string().min(1),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  /** How long the session had been idle when the sweep looked at it. */
  idle_hours: z.number().nonnegative(),
  /** Whether the stop actually went through. Stop only — gc never deletes. */
  stopped: z.boolean(),
  dry_run: z.boolean(),
  /** Present when the stop was attempted and failed. */
  error: z.string().optional(),
});
export type GcLogEntry = z.infer<typeof GcLogEntrySchema>;

export function parseGcLogLine(line: string): GcLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const result = GcLogEntrySchema.safeParse(JSON.parse(trimmed));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
