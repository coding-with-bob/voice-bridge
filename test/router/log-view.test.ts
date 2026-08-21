import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLogEvents, renderLogEvent, type LogEvent } from "../../src/router/log-view.ts";
import { pathsFor } from "../../src/config/load.ts";
import type { DecisionLogEntry } from "../../src/contracts/decision.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-logview-"));
  mkdirSync(join(home, "spoken"), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const paths = () => pathsFor(home);

const decision = (overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({
  ts: "2026-08-15T10:00:00.000Z",
  utterance: "and the other one too",
  context_digest: "2 candidates",
  decision: { action: "continue", session_id: "s1", request: "r", ack: "a" },
  latency_ms: 1800,
  model: "claude-opus-5",
  target_session_id: "s1",
  executed: true,
  reachback: false,
  peeked: false,
  fallback: false,
  ...overrides,
});

function writeDecisions(entries: DecisionLogEntry[]) {
  writeFileSync(paths().decisionLog, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

function writeSpoken(day: string, entries: Array<Record<string, unknown>>) {
  writeFileSync(
    join(home, "spoken", `${day}.jsonl`),
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
}

function writeGc(entries: Array<Record<string, unknown>>) {
  writeFileSync(paths().gcLog, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

describe("collectLogEvents", () => {
  test("merges the three logs into one chronological timeline", () => {
    writeSpoken("2026-08-15", [
      { ts: "2026-08-15T10:00:05.000Z", session_id: "s1", text: "Done.", voice: "Samantha", engine: "say" },
    ]);
    writeDecisions([decision({ ts: "2026-08-15T10:00:00.000Z" })]);
    writeGc([
      {
        ts: "2026-08-15T10:00:10.000Z",
        session_id: "s2",
        title: "old",
        workspace: null,
        idle_hours: 5.25,
        stopped: true,
        dry_run: false,
      },
    ]);

    const events = collectLogEvents({ homeDir: home, paths: paths() });
    expect(events.map((event) => event.kind)).toEqual(["decision", "spoken", "gc"]);
  });

  test("absent logs are an empty timeline, not an error", () => {
    expect(collectLogEvents({ homeDir: home, paths: paths() })).toEqual([]);
  });

  test("limit keeps the most recent events", () => {
    writeDecisions([
      decision({ ts: "2026-08-15T10:00:00.000Z", utterance: "first" }),
      decision({ ts: "2026-08-15T11:00:00.000Z", utterance: "second" }),
      decision({ ts: "2026-08-15T12:00:00.000Z", utterance: "third" }),
    ]);
    const events = collectLogEvents({ homeDir: home, paths: paths(), limit: 2 });
    expect(events).toHaveLength(2);
    expect((events[0] as Extract<LogEvent, { kind: "decision" }>).entry.utterance).toBe("second");
  });

  test("sources can be narrowed to one log", () => {
    writeSpoken("2026-08-15", [
      { ts: "2026-08-15T10:00:05.000Z", session_id: "s1", text: "Done.", voice: "Samantha", engine: "say" },
    ]);
    writeDecisions([decision()]);
    const events = collectLogEvents({ homeDir: home, paths: paths(), sources: ["spoken"] });
    expect(events.map((event) => event.kind)).toEqual(["spoken"]);
  });

  test("--reachbacks keeps only the decisions that reached back", () => {
    writeSpoken("2026-08-15", [
      { ts: "2026-08-15T10:00:05.000Z", session_id: "s1", text: "Done.", voice: "Samantha", engine: "say" },
    ]);
    writeDecisions([
      decision({ ts: "2026-08-15T09:00:00.000Z" }),
      decision({
        ts: "2026-08-15T10:00:00.000Z",
        reachback: true,
        reachback_reason: 'surfaced by ledger lookup "subtitle"',
        target_session_id: "july",
      }),
    ]);

    const events = collectLogEvents({ homeDir: home, paths: paths(), reachbacksOnly: true });
    expect(events).toHaveLength(1);
    const [event] = events as Array<Extract<LogEvent, { kind: "decision" }>>;
    expect(event!.entry.target_session_id).toBe("july");
  });

  test("a corrupt gc line costs that line, not the file", () => {
    writeFileSync(
      paths().gcLog,
      `${JSON.stringify({
        ts: "2026-08-15T10:00:00.000Z",
        session_id: "s2",
        title: null,
        workspace: null,
        idle_hours: 4,
        stopped: true,
        dry_run: false,
      })}\n{broken\n`,
      "utf8",
    );
    expect(collectLogEvents({ homeDir: home, paths: paths(), sources: ["gc"] })).toHaveLength(1);
  });
});

describe("renderLogEvent", () => {
  const render = (event: LogEvent) => renderLogEvent(event);

  test("a spoken line names the session, or the router when there is none", () => {
    expect(
      render({ kind: "spoken", ts: "2026-08-15T10:00:00.000Z", session_id: "s1", text: "Done.", engine: "say" }),
    ).toContain("spoke   [s1] Done.");
    expect(
      render({ kind: "spoken", ts: "2026-08-15T10:00:00.000Z", session_id: null, text: "Sent.", engine: "say" }),
    ).toContain("[router] Sent.");
  });

  test("a decision shows action, target, utterance and latency", () => {
    const line = render({ kind: "decision", ts: decision().ts, entry: decision() });
    expect(line).toContain("continue s1");
    expect(line).toContain('"and the other one too"');
    expect(line).toContain("1800ms");
  });

  test("a new session shows where it was born and which id it got", () => {
    const line = render({
      kind: "decision",
      ts: decision().ts,
      entry: decision({
        decision: { action: "new", cwd: "/Users/sam/dev/website", request: "r", ack: "a" },
        target_session_id: "conv_fresh",
      }),
    });
    expect(line).toContain("/Users/sam/dev/website (conv_fresh)");
  });

  test("the flags that matter are shown, with their reasons", () => {
    const line = render({
      kind: "decision",
      ts: decision().ts,
      entry: decision({
        reachback: true,
        reachback_reason: 'surfaced by ledger lookup "subtitle"',
        peeked: true,
      }),
    });
    expect(line).toContain("peeked");
    expect(line).toContain('reachback: surfaced by ledger lookup "subtitle"');
  });

  test("a fallback says why", () => {
    const line = render({
      kind: "decision",
      ts: decision().ts,
      entry: decision({
        fallback: true,
        fallback_reason: "model returned no JSON object",
        executed: false,
        target_session_id: null,
      }),
    });
    expect(line).toContain("fallback: model returned no JSON object");
    expect(line).toContain("not executed");
  });

  /**
   * The logs store UTC (right for machines and for merging), but `bob log` is a person
   * reading their own day — a 09:19 question rendered as "07:19" sent the first real
   * investigation two hours astray (2026-08-16).
   */
  test("times are rendered in local time, not the stored UTC", () => {
    const saved = process.env.TZ;
    process.env.TZ = "Europe/Budapest"; // UTC+2 in August
    try {
      expect(
        render({ kind: "spoken", ts: "2026-08-16T07:19:57.639Z", session_id: null, text: "x", engine: "say" }),
      ).toStartWith("2026-08-16 09:19:57");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test("an unparseable timestamp falls back to the raw string rather than NaN", () => {
    expect(
      render({ kind: "spoken", ts: "not-a-date", session_id: null, text: "x", engine: "say" }),
    ).toContain("not-a-date");
  });

  test("a gc line distinguishes a real stop from a proposed one", () => {
    const entry = {
      ts: "2026-08-15T10:00:00.000Z",
      session_id: "s2",
      title: null,
      workspace: null,
      idle_hours: 5.25,
      stopped: true,
      dry_run: false,
    };
    expect(render({ kind: "gc", ts: entry.ts, entry })).toContain("stopped s2 · idle 5.3h");
    expect(
      render({ kind: "gc", ts: entry.ts, entry: { ...entry, stopped: false, dry_run: true } }),
    ).toContain("would stop s2");
  });
});
