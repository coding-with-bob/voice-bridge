import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDecisionEntry,
  readDecisionEntries,
  dispatchEvents,
} from "../../src/router/decision-log.ts";
import type { DecisionLogEntry } from "../../src/contracts/decision.ts";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-decisions-"));
  logPath = join(dir, "logs", "route-decisions.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({
  ts: "2026-08-15T10:00:00.000Z",
  utterance: "add the missing test",
  context_digest: "3 candidates",
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

describe("appendDecisionEntry", () => {
  test("creates the log directory on first write", () => {
    appendDecisionEntry(logPath, entry());
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("appends rather than replaces", () => {
    appendDecisionEntry(logPath, entry());
    appendDecisionEntry(logPath, entry({ utterance: "second" }));
    expect(readDecisionEntries(logPath, {})).toHaveLength(2);
  });
});

describe("readDecisionEntries", () => {
  test("an absent log is empty, not an error", () => {
    expect(readDecisionEntries(logPath, {})).toEqual([]);
  });

  test("skips corrupt lines", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(logPath, `${JSON.stringify(entry())}\n{broken\n`, "utf8");
    expect(readDecisionEntries(logPath, {})).toHaveLength(1);
  });

  test("limit keeps the most recent entries, in order", () => {
    for (const index of [1, 2, 3]) {
      appendDecisionEntry(logPath, entry({ utterance: `u${index}` }));
    }
    expect(readDecisionEntries(logPath, { limit: 2 }).map((row) => row.utterance)).toEqual([
      "u2",
      "u3",
    ]);
  });
});

describe("dispatchEvents", () => {
  test("keeps only entries that actually reached a session", () => {
    const events = dispatchEvents([
      entry({ target_session_id: "s1", executed: true }),
      entry({ target_session_id: "s2", executed: false }),
      entry({ target_session_id: null, executed: true }),
    ]);
    expect(events).toEqual([{ session_id: "s1", ts: "2026-08-15T10:00:00.000Z" }]);
  });

  test("a new session's dispatch counts too — the target is recorded, not inferred", () => {
    const events = dispatchEvents([
      entry({
        decision: { action: "new", cwd: "/Users/sam/dev/website", request: "r", ack: "a" },
        target_session_id: "fresh",
        executed: true,
      }),
    ]);
    expect(events[0]!.session_id).toBe("fresh");
  });
});
