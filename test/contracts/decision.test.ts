import { describe, expect, test } from "bun:test";
import {
  RouterDecisionSchema,
  DecisionLogEntrySchema,
  parseRouterDecision,
} from "../../src/contracts/decision.ts";

describe("C5 router decision — discriminated union", () => {
  test("accepts a complete continue decision", () => {
    const parsed = RouterDecisionSchema.parse({
      action: "continue",
      session_id: "sess-1",
      request: "add the missing test",
      ack: "Passing it to the subtitle session.",
    });
    expect(parsed.action).toBe("continue");
    if (parsed.action === "continue") expect(parsed.session_id).toBe("sess-1");
  });

  test("accepts a complete new decision", () => {
    const parsed = RouterDecisionSchema.parse({
      action: "new",
      cwd: "/Users/felho/dev/confpipeline",
      request: "summarise the readme",
      ack: "Starting a fresh session in confpipeline.",
    });
    expect(parsed.action).toBe("new");
  });

  /**
   * A spoken request may name the model the new session is born on. It is optional because
   * the config default is the answer almost every time, and it lives only on `new`: Omnigent
   * persists `terminal_launch_args` onto the session, so a revived session comes back on the
   * model it was born with. There is no such thing as continuing a session differently.
   */
  test("a new decision may name the model and effort it is born with", () => {
    const parsed = RouterDecisionSchema.parse({
      action: "new",
      cwd: "/Users/felho/dev/queries",
      request: "summarise the PDF",
      ack: "Új session Fable-lel: queries.",
      model: "claude-fable-5",
      effort: "medium",
    });
    expect(parsed.action).toBe("new");
    if (parsed.action === "new") {
      expect(parsed.model).toBe("claude-fable-5");
      expect(parsed.effort).toBe("medium");
    }
  });

  test("an effort Claude Code does not have is not a decision", () => {
    const result = parseRouterDecision({
      action: "new",
      cwd: "/tmp",
      request: "r",
      ack: "a",
      effort: "enthusiastic",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts clarify and lookup_ledger", () => {
    expect(
      RouterDecisionSchema.parse({ action: "clarify", question: "Which project?" }).action,
    ).toBe("clarify");
    expect(
      RouterDecisionSchema.parse({ action: "lookup_ledger", query: "subtitle" }).action,
    ).toBe("lookup_ledger");
  });

  test("any variant may carry candidates", () => {
    const parsed = RouterDecisionSchema.parse({
      action: "clarify",
      question: "Which one?",
      candidates: [
        { session_id: "a", reason: "mentions subtitles" },
        { session_id: "b", reason: "same workspace" },
      ],
    });
    expect(parsed.candidates).toHaveLength(2);
  });

  // The contract's core promise: structurally valid but unexecutable must be impossible.
  test("rejects continue without a session_id", () => {
    expect(() =>
      RouterDecisionSchema.parse({ action: "continue", request: "r", ack: "a" }),
    ).toThrow();
  });

  test("rejects continue with an empty session_id", () => {
    expect(() =>
      RouterDecisionSchema.parse({ action: "continue", session_id: "", request: "r", ack: "a" }),
    ).toThrow();
  });

  test("rejects new without a cwd", () => {
    expect(() => RouterDecisionSchema.parse({ action: "new", request: "r", ack: "a" })).toThrow();
  });

  test("rejects continue carrying a cwd instead of a session_id", () => {
    expect(() =>
      RouterDecisionSchema.parse({ action: "continue", cwd: "/tmp", request: "r", ack: "a" }),
    ).toThrow();
  });

  test("rejects an unknown action", () => {
    expect(() => RouterDecisionSchema.parse({ action: "delete", session_id: "x" })).toThrow();
  });

  test("rejects clarify without a question", () => {
    expect(() => RouterDecisionSchema.parse({ action: "clarify" })).toThrow();
  });

  test("tolerates extra keys the model volunteers (they are stripped)", () => {
    const parsed = RouterDecisionSchema.parse({
      action: "clarify",
      question: "Which project?",
      confidence: 0.4,
    });
    expect(parsed).toEqual({ action: "clarify", question: "Which project?" });
  });
});

describe("parseRouterDecision", () => {
  test("returns ok for a valid decision", () => {
    const result = parseRouterDecision({ action: "clarify", question: "Which?" });
    expect(result.ok).toBe(true);
  });

  test("returns a reason instead of throwing for an invalid decision", () => {
    const result = parseRouterDecision({ action: "continue", request: "r", ack: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("session_id");
  });
});

describe("C5 decision log entry", () => {
  const entry = {
    ts: "2026-08-15T10:00:00.000Z",
    utterance: "add the missing test",
    context_digest: "3 sessions; last spoken sess-1 4m ago",
    decision: { action: "continue", session_id: "sess-1", request: "r", ack: "a" },
    latency_ms: 1840,
    model: "claude-opus-5",
    target_session_id: "sess-1",
    executed: true,
    reachback: false,
    peeked: false,
    fallback: false,
  };

  test("accepts a complete entry", () => {
    expect(DecisionLogEntrySchema.parse(entry).executed).toBe(true);
  });

  test("accepts a null target when nothing was dispatched", () => {
    const clarified = {
      ...entry,
      decision: { action: "clarify", question: "Which project?" },
      target_session_id: null,
      executed: false,
    };
    expect(DecisionLogEntrySchema.parse(clarified).target_session_id).toBeNull();
  });

  test("requires the fields that drive recency and reporting", () => {
    for (const key of [
      "ts",
      "target_session_id",
      "executed",
      "reachback",
      "peeked",
      "fallback",
    ] as const) {
      const { [key]: _dropped, ...rest } = entry;
      expect(() => DecisionLogEntrySchema.parse(rest)).toThrow();
    }
  });
});
