import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpokenEntries, grepSpokenLedger } from "../../src/router/ledger.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-ledger-"));
  mkdirSync(join(home, "spoken"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeDay(day: string, entries: Array<Record<string, unknown>>): void {
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(join(home, "spoken", `${day}.jsonl`), `${lines}\n`, "utf8");
}

const line = (ts: string, session: string | null, text: string) => ({
  ts,
  session_id: session,
  text,
  voice: "Samantha",
  engine: "say",
});

describe("readSpokenEntries", () => {
  test("reads across days, oldest first", () => {
    writeDay("2026-08-14", [line("2026-08-14T10:00:00.000Z", "s1", "older")]);
    writeDay("2026-08-15", [line("2026-08-15T10:00:00.000Z", "s2", "newer")]);
    expect(readSpokenEntries(home, {}).map((entry) => entry.text)).toEqual(["older", "newer"]);
  });

  test("an absent spoken directory is empty, not an error", () => {
    rmSync(join(home, "spoken"), { recursive: true, force: true });
    expect(readSpokenEntries(home, {})).toEqual([]);
  });

  test("missing days in the middle are simply absent", () => {
    writeDay("2026-08-01", [line("2026-08-01T10:00:00.000Z", "s1", "first")]);
    writeDay("2026-08-15", [line("2026-08-15T10:00:00.000Z", "s1", "last")]);
    expect(readSpokenEntries(home, {})).toHaveLength(2);
  });

  test("corrupt lines are skipped, the rest of the day survives", () => {
    writeDay("2026-08-15", [line("2026-08-15T10:00:00.000Z", "s1", "good")]);
    writeFileSync(
      join(home, "spoken", "2026-08-15.jsonl"),
      `${JSON.stringify(line("2026-08-15T10:00:00.000Z", "s1", "good"))}\n{half a line\n`,
      "utf8",
    );
    expect(readSpokenEntries(home, {}).map((entry) => entry.text)).toEqual(["good"]);
  });

  test("sinceDays keeps only the recent days", () => {
    writeDay("2026-08-01", [line("2026-08-01T10:00:00.000Z", "s1", "old")]);
    writeDay("2026-08-14", [line("2026-08-14T10:00:00.000Z", "s1", "recent")]);
    const entries = readSpokenEntries(home, { sinceDays: 3, now: new Date(2026, 7, 15, 12) });
    expect(entries.map((entry) => entry.text)).toEqual(["recent"]);
  });

  test("files that are not daily logs are ignored", () => {
    writeFileSync(join(home, "spoken", "notes.txt"), "not a log\n", "utf8");
    writeDay("2026-08-15", [line("2026-08-15T10:00:00.000Z", "s1", "real")]);
    expect(readSpokenEntries(home, {})).toHaveLength(1);
  });
});

describe("grepSpokenLedger", () => {
  beforeEach(() => {
    writeDay("2026-07-08", [
      line("2026-07-08T10:00:00.000Z", "july", "The subtitle pipeline is done."),
      line("2026-07-08T11:00:00.000Z", "other", "Invoices exported."),
    ]);
    writeDay("2026-08-15", [line("2026-08-15T10:00:00.000Z", "today", "Subtitles again.")]);
  });

  const sessionsOf = (query: string) =>
    grepSpokenLedger(home, query).map((hit) => hit.entry.session_id);

  test("searches the whole ledger, with no horizon", () => {
    expect(sessionsOf("subtitle").sort()).toEqual(["july", "today"]);
  });

  test("is case-insensitive and matches on substrings", () => {
    expect(grepSpokenLedger(home, "SUBTITLE")).toHaveLength(2);
    expect(grepSpokenLedger(home, "invoice")).toHaveLength(1);
  });

  /**
   * Deliberately partial. The query is a model paraphrasing a spoken memory, so it will
   * carry words the ledger line never had — the first live run searched for
   * "conference badge printing July" against a line containing everything but "July",
   * and an all-words rule found nothing at all.
   */
  test("scores partial matches instead of demanding every word", () => {
    const hits = grepSpokenLedger(home, "subtitle nonexistent");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBe(1);
  });

  test("ranks the line that matches more of the query first", () => {
    const hits = grepSpokenLedger(home, "subtitle pipeline");
    expect(hits[0]!.entry.session_id).toBe("july");
    expect(hits[0]!.score).toBe(2);
    expect(hits[1]!.score).toBe(1);
  });

  test("ignores words too short to carry signal", () => {
    expect(grepSpokenLedger(home, "is a of")).toEqual([]);
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(grepSpokenLedger(home, "   ")).toEqual([]);
  });

  test("sessionless lines cannot be reached back to", () => {
    writeDay("2026-08-16", [line("2026-08-16T10:00:00.000Z", null, "subtitle ack")]);
    expect(sessionsOf("subtitle").every((id) => id !== null)).toBe(true);
  });
});
