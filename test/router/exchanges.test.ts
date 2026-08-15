import { describe, expect, test } from "bun:test";
import { buildExchanges } from "../../src/router/exchanges.ts";
import type { DecisionLogEntry } from "../../src/contracts/decision.ts";
import type { SpokenLogEntry } from "../../src/contracts/spoken-log.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const decision = (overrides: Partial<DecisionLogEntry>): DecisionLogEntry => ({
  ts: minutesAgo(10),
  utterance: "an utterance",
  context_digest: "…",
  decision: { action: "continue", session_id: "s1", request: "r", ack: "a" },
  latency_ms: 100,
  model: "m",
  target_session_id: "s1",
  executed: true,
  reachback: false,
  peeked: false,
  fallback: false,
  ...overrides,
});

const spoke = (session_id: string | null, text: string, minutes: number): SpokenLogEntry => ({
  ts: minutesAgo(minutes),
  session_id,
  text,
  voice: "V",
  engine: "say",
});

describe("buildExchanges — the dialogue, reassembled at read time", () => {
  test("links a dispatch to the target's first spoken reply after it", () => {
    const exchanges = buildExchanges({
      decisions: [decision({ ts: minutesAgo(10), utterance: "mi volt a legutolsó sorozat?" })],
      spoken: [
        spoke("s1", "an older line from before the question", 30),
        spoke("s1", "A Star Trek S04E04 letöltése kész.", 8),
      ],
      now: NOW,
    });

    expect(exchanges).toEqual([
      {
        minutes_ago: 10,
        utterance: "mi volt a legutolsó sorozat?",
        action: "continue",
        target_session_id: "s1",
        reply: "A Star Trek S04E04 letöltése kész.",
      },
    ]);
  });

  test("a dispatch with no reply yet carries null, not a stale line", () => {
    const exchanges = buildExchanges({
      decisions: [decision({ ts: minutesAgo(2) })],
      spoken: [spoke("s1", "spoken before the dispatch", 5)],
      now: NOW,
    });
    expect(exchanges[0]!.reply).toBeNull();
  });

  test("a clarify's reply is its own question — no join needed", () => {
    const exchanges = buildExchanges({
      decisions: [
        decision({
          decision: { action: "clarify", question: "Melyikre gondolsz?" },
          target_session_id: null,
          executed: false,
        }),
      ],
      spoken: [],
      now: NOW,
    });
    expect(exchanges[0]).toMatchObject({ action: "clarify", reply: "Melyikre gondolsz?" });
  });

  test("another session's speech is never mistaken for the reply", () => {
    const exchanges = buildExchanges({
      decisions: [decision({ ts: minutesAgo(10) })],
      spoken: [spoke("someone-else", "not the answer", 8), spoke(null, "a router ack", 9)],
      now: NOW,
    });
    expect(exchanges[0]!.reply).toBeNull();
  });

  test("keeps the last N, oldest first — bounded by construction", () => {
    const decisions = Array.from({ length: 10 }, (_, i) =>
      decision({ ts: minutesAgo(100 - i * 10), utterance: `question ${i}` }),
    );
    const exchanges = buildExchanges({ decisions, spoken: [], now: NOW, limit: 3 });

    expect(exchanges.map((x) => x.utterance)).toEqual(["question 7", "question 8", "question 9"]);
    expect(exchanges[0]!.minutes_ago).toBeGreaterThan(exchanges[2]!.minutes_ago);
  });

  test("an unparseable decision is skipped, not rendered as a hole", () => {
    const exchanges = buildExchanges({
      decisions: [decision({ decision: null, target_session_id: null, executed: false })],
      spoken: [],
      now: NOW,
    });
    expect(exchanges).toEqual([]);
  });

  test("long text is truncated — this feeds a prompt, not an archive", () => {
    const exchanges = buildExchanges({
      decisions: [decision({ utterance: "x".repeat(400) })],
      spoken: [spoke("s1", "y".repeat(400), 5)],
      now: NOW,
    });
    expect(exchanges[0]!.utterance.length).toBeLessThan(130);
    expect(exchanges[0]!.utterance.endsWith("…")).toBe(true);
    expect(exchanges[0]!.reply!.length).toBeLessThan(130);
  });
});
