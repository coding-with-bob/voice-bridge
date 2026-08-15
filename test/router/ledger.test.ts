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
  voice: "Tünde",
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

  test("searches the whole ledger, with no horizon", () => {
    const hits = grepSpokenLedger(home, "subtitle");
    expect(hits.map((entry) => entry.session_id)).toEqual(["july", "today"]);
  });

  test("is case-insensitive and matches on substrings", () => {
    expect(grepSpokenLedger(home, "SUBTITLE")).toHaveLength(2);
    expect(grepSpokenLedger(home, "invoice")).toHaveLength(1);
  });

  test("matches every word of a multi-word query, in any order", () => {
    expect(grepSpokenLedger(home, "pipeline subtitle")).toHaveLength(1);
    expect(grepSpokenLedger(home, "subtitle nonexistent")).toHaveLength(0);
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(grepSpokenLedger(home, "   ")).toEqual([]);
  });

  test("sessionless lines cannot be reached back to", () => {
    writeDay("2026-08-16", [line("2026-08-16T10:00:00.000Z", null, "subtitle ack")]);
    expect(grepSpokenLedger(home, "subtitle").every((entry) => entry.session_id !== null)).toBe(
      true,
    );
  });
});
