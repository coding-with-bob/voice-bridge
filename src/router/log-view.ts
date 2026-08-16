/**
 * `bob log` — one timeline over the three logs.
 *
 * They are separate files because they are written by separate things at separate moments,
 * but they are read as one story: the utterance went here, that session spoke back, the
 * sweep stopped it overnight. Merging at read time keeps the writers simple and the reader
 * honest — the same principle that removed the pointer files from C2.
 */
import { existsSync, readFileSync } from "node:fs";
import type { BobPaths } from "../config/load.ts";
import { parseGcLogLine, type GcLogEntry } from "../contracts/gc-log.ts";
import type { DecisionLogEntry } from "../contracts/decision.ts";
import { readDecisionEntries } from "./decision-log.ts";
import { readSpokenEntries } from "./ledger.ts";

export type LogSource = "spoken" | "decisions" | "gc";
export const ALL_SOURCES: readonly LogSource[] = ["spoken", "decisions", "gc"];

export type LogEvent =
  | { kind: "spoken"; ts: string; session_id: string | null; text: string; engine: string }
  | { kind: "decision"; ts: string; entry: DecisionLogEntry }
  | { kind: "gc"; ts: string; entry: GcLogEntry };

export interface LogViewOptions {
  homeDir: string;
  paths: BobPaths;
  sources?: readonly LogSource[];
  /** Keep only reach-backs — the signal worth watching, per the design. */
  reachbacksOnly?: boolean;
  limit?: number;
  /** How far back to read the daily spoken files. */
  sinceDays?: number;
  now?: Date;
}

export function collectLogEvents(options: LogViewOptions): LogEvent[] {
  const sources = new Set(options.sources ?? ALL_SOURCES);
  const reachbacksOnly = options.reachbacksOnly === true;
  const events: LogEvent[] = [];

  // A reach-back is a property of a decision; asking for reach-backs means asking for those.
  if (sources.has("spoken") && !reachbacksOnly) {
    for (const entry of readSpokenEntries(options.homeDir, {
      ...(options.sinceDays === undefined ? {} : { sinceDays: options.sinceDays }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })) {
      events.push({
        kind: "spoken",
        ts: entry.ts,
        session_id: entry.session_id,
        text: entry.text,
        engine: entry.engine,
      });
    }
  }

  if (sources.has("decisions")) {
    for (const entry of readDecisionEntries(options.paths.decisionLog, {})) {
      if (reachbacksOnly && !entry.reachback) continue;
      events.push({ kind: "decision", ts: entry.ts, entry });
    }
  }

  if (sources.has("gc") && !reachbacksOnly) {
    for (const entry of readGcEntries(options.paths.gcLog)) {
      events.push({ kind: "gc", ts: entry.ts, entry });
    }
  }

  events.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  return options.limit === undefined ? events : events.slice(-options.limit);
}

export function readGcEntries(gcLogPath: string): GcLogEntry[] {
  if (!existsSync(gcLogPath)) return [];
  try {
    return readFileSync(gcLogPath, "utf8")
      .split("\n")
      .map(parseGcLogLine)
      .filter((entry): entry is GcLogEntry => entry !== null);
  } catch {
    return [];
  }
}

/**
 * The logs store UTC; the timeline is read by a person placing events in their own day,
 * so rendering converts to local time. Machines get the raw ISO strings via `--json`.
 */
function localTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function renderLogEvent(event: LogEvent): string {
  const time = localTime(event.ts);
  switch (event.kind) {
    case "spoken":
      return `${time}  spoke   [${event.session_id ?? "router"}] ${event.text}`;
    case "gc": {
      const outcome = event.entry.dry_run
        ? "would stop"
        : event.entry.stopped
          ? "stopped"
          : `failed to stop (${event.entry.error ?? "unknown"})`;
      return `${time}  gc      ${outcome} ${event.entry.session_id} · idle ${event.entry.idle_hours.toFixed(1)}h`;
    }
    case "decision":
      return `${time}  route   ${describeDecision(event.entry)}`;
  }
}

function describeDecision(entry: DecisionLogEntry): string {
  const action = entry.decision?.action ?? "(unparsed)";
  const target =
    entry.decision?.action === "new"
      ? `${entry.decision.cwd}${entry.target_session_id === null ? "" : ` (${entry.target_session_id})`}`
      : (entry.target_session_id ?? "");

  const flags = [
    entry.fallback ? `fallback: ${entry.fallback_reason ?? "unspecified"}` : null,
    entry.peeked ? "peeked" : null,
    entry.reachback ? `reachback${entry.reachback_reason === undefined ? "" : `: ${entry.reachback_reason}`}` : null,
    entry.executed ? null : "not executed",
  ].filter((flag): flag is string => flag !== null);

  return (
    `${action}${target === "" ? "" : ` ${target}`} · "${entry.utterance}" · ${entry.latency_ms}ms` +
    (flags.length === 0 ? "" : ` [${flags.join("; ")}]`)
  );
}
