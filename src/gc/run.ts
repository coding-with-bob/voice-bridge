/**
 * `bob gc` — process hygiene, on an hourly scale.
 *
 * It stops. It never deletes. That asymmetry is the whole safety argument: stopping is
 * free to get wrong (the transcript survives and the next message relaunches the session in
 * about three seconds), while deleting destroys the record a reach-back might need in July.
 * Removing a session stays a human act, done in the UI, deliberately.
 *
 * Sessions that are `running` or `waiting` are never touched however long they have been at
 * it. A long-running task is not idle, and a session parked on a question is waiting for a
 * human, not wasting a process.
 */
import type { OmnigentClient } from "../omnigent/client.ts";
import type { PoolSession } from "../omnigent/parse.ts";
import { GcLogEntrySchema, type GcLogEntry } from "../contracts/gc-log.ts";

export interface GcDeps {
  client: Pick<OmnigentClient, "listSessions" | "stopSession">;
  idleHours: number;
  dryRun: boolean;
  now?: () => Date;
}

export interface GcResult {
  scanned: number;
  /** One entry per session the sweep acted on (or would have acted on). */
  entries: GcLogEntry[];
}

/** Statuses that mean "something is happening here" — never swept. */
const BUSY = new Set(["running", "waiting"]);

export async function runGc(deps: GcDeps): Promise<GcResult> {
  const now = (deps.now ?? (() => new Date()))();
  const sessions = await deps.client.listSessions();
  const entries: GcLogEntry[] = [];

  for (const session of sessions) {
    const idleHours = idleHoursOf(session, now);
    if (!isSweepable(session, idleHours, deps.idleHours)) continue;

    const base = {
      ts: now.toISOString(),
      session_id: session.id,
      title: session.title,
      workspace: session.workspace,
      idle_hours: Number(idleHours.toFixed(2)),
      dry_run: deps.dryRun,
    };

    if (deps.dryRun) {
      entries.push(GcLogEntrySchema.parse({ ...base, stopped: false }));
      continue;
    }

    try {
      await deps.client.stopSession(session.id);
      entries.push(GcLogEntrySchema.parse({ ...base, stopped: true }));
    } catch (error) {
      // One session refusing to stop is not a reason to abandon the sweep.
      entries.push(
        GcLogEntrySchema.parse({
          ...base,
          stopped: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return { scanned: sessions.length, entries };
}

function isSweepable(session: PoolSession, idleHours: number, threshold: number): boolean {
  if (session.archived || BUSY.has(session.status)) return false;
  return idleHours > threshold;
}

function idleHoursOf(session: PoolSession, now: Date): number {
  const activeAt = session.updated_at ?? session.created_at;
  return (now.getTime() / 1000 - activeAt) / 3600;
}
