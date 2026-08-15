/**
 * Readers over the C2 spoken ledger.
 *
 * Two very different reads live here. Routing context wants the recent tail — a few days,
 * a line or two per session. Reach-back wants the opposite: the whole ledger, no horizon,
 * because "that subtitle session from July" is exactly the case the candidate window cuts off.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpokenLogLine, type SpokenLogEntry } from "../contracts/spoken-log.ts";

const DAILY_LOG = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function readSpokenEntries(
  homeDir: string,
  options: { sinceDays?: number; now?: Date },
): SpokenLogEntry[] {
  const days = dailyLogs(homeDir);
  const cutoff = options.sinceDays === undefined ? null : dayStamp(options.sinceDays, options.now);
  const entries: SpokenLogEntry[] = [];
  for (const { day, path } of days) {
    if (cutoff !== null && day < cutoff) continue;
    entries.push(...readDay(path));
  }
  return entries;
}

/**
 * The reach-back path: every day, every line. A hit only counts when it names a session —
 * a sessionless router ack cannot be reached back to.
 */
export function grepSpokenLedger(homeDir: string, query: string): SpokenLogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];

  return readSpokenEntries(homeDir, {}).filter((entry) => {
    if (entry.session_id === null) return false;
    const haystack = entry.text.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function dailyLogs(homeDir: string): Array<{ day: string; path: string }> {
  const dir = join(homeDir, "spoken");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, match: DAILY_LOG.exec(name) }))
    .filter((candidate): candidate is { name: string; match: RegExpExecArray } => candidate.match !== null)
    .map(({ name, match }) => ({ day: match[1]!, path: join(dir, name) }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

function readDay(path: string): SpokenLogEntry[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map(parseSpokenLogLine)
      .filter((entry): entry is SpokenLogEntry => entry !== null);
  } catch {
    return []; // a day we cannot read is a day we do not have
  }
}

/** `YYYY-MM-DD` of the day `sinceDays` back, in local time — the same grouping the writer uses. */
function dayStamp(sinceDays: number, now: Date | undefined): string {
  const reference = now ?? new Date();
  const cutoff = new Date(reference);
  cutoff.setDate(cutoff.getDate() - sinceDays);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
}
