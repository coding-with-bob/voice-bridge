import { describe, expect, test } from "bun:test";
import {
  disregardTextFor,
  isDeletableMistake,
  repairPrevious,
  type RepairDeps,
} from "../../src/router/repair.ts";
import type { DecisionLogEntry } from "../../src/contracts/decision.ts";
import type { SessionState } from "../../src/omnigent/parse.ts";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const DISREGARD_MARK = "misrouted and is not your task";

function entry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    ts: NOW.toISOString(),
    utterance: "u",
    context_digest: "d",
    decision: { action: "new", cwd: "/tmp", request: "r", ack: "a" },
    latency_ms: 10,
    model: "claude-opus-5",
    target_session_id: "sess-mistake",
    executed: true,
    reachback: false,
    peeked: false,
    fallback: false,
    ...overrides,
  };
}

function stub(state: SessionState) {
  const calls: string[] = [];
  const client = {
    interrupt: async (id: string) => void calls.push(`interrupt:${id}`),
    deleteSession: async (id: string) => void calls.push(`delete:${id}`),
    postMessage: async (id: string, text: string) => {
      calls.push(`message:${id}:${text.includes(DISREGARD_MARK) ? "disregard" : text}`);
      return { pendingId: null };
    },
    sessionState: async (id: string) => {
      calls.push(`state:${id}`);
      return state;
    },
  };
  const deps: RepairDeps = {
    client,
    windowMs: 10 * 60_000,
    now: () => NOW,
    disregardText: disregardTextFor,
  };
  return { calls, deps };
}

const idle: SessionState = { status: "idle", pending_inputs: [], runner_online: true };
const asleep: SessionState = { status: "idle", pending_inputs: [], runner_online: false };
const running = (pending: string[] = []): SessionState => ({
  status: "running",
  pending_inputs: pending,
  runner_online: true,
});

describe("isDeletableMistake — the fence, not the care", () => {
  test("a session the previous decision itself created is deletable", () => {
    expect(isDeletableMistake(entry(), [entry()], NOW, 600_000)).toBe(true);
  });

  test("a continue target is never deletable — it existed before the mistake", () => {
    const previous = entry({
      decision: { action: "continue", session_id: "sess-real", request: "r", ack: "a" },
      target_session_id: "sess-real",
    });
    expect(isDeletableMistake(previous, [previous], NOW, 600_000)).toBe(false);
  });

  test("a session used since is not a mistake any more, whatever the utterance says", () => {
    const previous = entry({ ts: "2026-08-16T11:58:00.000Z" });
    const later = entry({ ts: "2026-08-16T11:59:00.000Z", utterance: "and one more thing" });
    expect(isDeletableMistake(previous, [previous, later], NOW, 600_000)).toBe(false);
  });

  test("an old mistake is out of reach — the window is part of the fence", () => {
    const previous = entry({ ts: "2026-08-16T11:00:00.000Z" });
    expect(isDeletableMistake(previous, [previous], NOW, 600_000)).toBe(false);
  });

  test("a decision that never dispatched has nothing to delete", () => {
    const previous = entry({ executed: false });
    expect(isDeletableMistake(previous, [previous], NOW, 600_000)).toBe(false);
  });
});

describe("repairPrevious", () => {
  test("nothing dispatched, nothing to undo", async () => {
    const { calls, deps } = stub(idle);
    expect(await repairPrevious(null, [], deps)).toEqual({
      outcome: "nothing-to-undo",
      sessionId: null,
    });
    expect(calls).toEqual([]);
  });

  test("a wrongly born session is interrupted and deleted, leaving no junk candidate", async () => {
    const { calls, deps } = stub(idle);
    const previous = entry();
    const result = await repairPrevious(previous, [previous], deps);
    expect(result).toEqual({ outcome: "deleted", sessionId: "sess-mistake", ofTs: NOW.toISOString() });
    expect(calls).toEqual(["interrupt:sess-mistake", "delete:sess-mistake"]);
  });

  /**
   * The case the whole module exists for. The session was already busy with something
   * legitimate and our message is still queued behind it. Interrupting would cancel that
   * work and then let the misrouted message start next — so the process is left alone.
   */
  test("a message still queued behind live work is NOT interrupted", async () => {
    const { calls, deps } = stub(running(["pending_ours"]));
    const previous = entry({
      decision: { action: "continue", session_id: "sess-busy", request: "r", ack: "a" },
      target_session_id: "sess-busy",
      pending_id: "pending_ours",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("queued-not-withdrawable");
    expect(calls).not.toContain("interrupt:sess-busy");
    expect(calls).toContain("message:sess-busy:disregard");
  });

  test("dispatched to an idle session, drained, busy now — the turn is provably ours", async () => {
    const { calls, deps } = stub(running([]));
    const previous = entry({
      decision: { action: "continue", session_id: "sess-busy", request: "r", ack: "a" },
      target_session_id: "sess-busy",
      pending_id: "pending_ours",
      target_status_at_dispatch: "idle",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("interrupted");
    expect(calls).toContain("interrupt:sess-busy");
  });

  /**
   * The branch the first microphone trial fell through (2026-08-17). Measured: a queued
   * message drains at the first tool boundary of a *foreign* turn and merges into it —
   * 3s in, with the turn still running. "Drained + busy" therefore proves nothing about
   * whose turn is running; what does is the fact recorded at dispatch time. A message sent
   * to an already-busy session can never be interrupted later, only disowned by note.
   */
  test("dispatched to a busy session — never interrupted, whatever the queue says now", async () => {
    const { calls, deps } = stub(running([]));
    const previous = entry({
      decision: { action: "continue", session_id: "sess-busy", request: "r", ack: "a" },
      target_session_id: "sess-busy",
      pending_id: "pending_ours",
      target_status_at_dispatch: "running",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("foreign-turn");
    expect(calls).not.toContain("interrupt:sess-busy");
    expect(calls).toContain("message:sess-busy:disregard");
  });

  test("dispatched when idle but something else sent since — proof lost, no interrupt", async () => {
    const { calls, deps } = stub(running([]));
    const previous = entry({
      ts: "2026-08-16T11:58:00.000Z",
      decision: { action: "continue", session_id: "sess-busy", request: "r", ack: "a" },
      target_session_id: "sess-busy",
      pending_id: "pending_ours",
      target_status_at_dispatch: "idle",
    });
    const later = entry({
      ts: "2026-08-16T11:59:00.000Z",
      decision: { action: "continue", session_id: "sess-busy", request: "other", ack: "a" },
      target_session_id: "sess-busy",
    });
    const result = await repairPrevious(previous, [previous, later], deps);
    expect(result.outcome).toBe("cannot-verify");
    expect(calls).not.toContain("interrupt:sess-busy");
  });

  /**
   * Without a pending id there is no proof that the running turn is ours — only an
   * inference. The two errors are not symmetric: failing to stop a bad message wastes a
   * turn, cancelling the wrong one destroys work someone is waiting for.
   */
  test("a busy session with neither an id nor a dispatch-time status is left running", async () => {
    const { calls, deps } = stub(running([]));
    const previous = entry({
      decision: { action: "continue", session_id: "sess-busy", request: "r", ack: "a" },
      target_session_id: "sess-busy",
      pending_id: null,
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("cannot-verify");
    expect(calls).not.toContain("interrupt:sess-busy");
    expect(calls).toContain("message:sess-busy:disregard");
  });

  /**
   * "The previous message" is ambiguous exactly in the case the semantic correction exists
   * for: a good dispatch arrived after the mistake, so "previous" points at the wrong one.
   * The note names the misrouted request by content instead.
   */
  test("the disregard note quotes the misrouted request, not its position", () => {
    const note = disregardTextFor("did the invoice export include the November numbers?");
    expect(note).toContain('"did the invoice export include the November numbers?"');
    expect(note).not.toContain("previous message");
  });

  /**
   * A stopped session's status still reads "idle" — only runner_online separates asleep
   * from awake (probed live, 2026-08-17). Posting the note would revive it: spawn a
   * process, burn the ~3s, all to deliver "ignore something you are not working on".
   * The mistake has already run its course; sleep is left alone.
   */
  test("a gc-stopped session is not revived just to be told to disregard", async () => {
    const { calls, deps } = stub(asleep);
    const previous = entry({
      decision: { action: "continue", session_id: "sess-gone", request: "r", ack: "a" },
      target_session_id: "sess-gone",
      pending_id: "pending_ours",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("left-asleep");
    expect(calls).not.toContain("message:sess-gone:disregard");
    expect(calls).not.toContain("interrupt:sess-gone");
  });

  test("unknown liveness is treated as awake — a note beats a wrong guess", async () => {
    const { calls, deps } = stub({ status: "idle", pending_inputs: [], runner_online: null });
    const previous = entry({
      decision: { action: "continue", session_id: "sess-x", request: "r", ack: "a" },
      target_session_id: "sess-x",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("already-finished");
    expect(calls).toContain("message:sess-x:disregard");
  });

  test("an idle session has already done it — the note is all that is left", async () => {
    const { calls, deps } = stub(idle);
    const previous = entry({
      decision: { action: "continue", session_id: "sess-done", request: "r", ack: "a" },
      target_session_id: "sess-done",
      pending_id: "pending_ours",
    });
    const result = await repairPrevious(previous, [previous], deps);
    expect(result.outcome).toBe("already-finished");
    expect(calls).not.toContain("interrupt:sess-done");
    expect(calls).toContain("message:sess-done:disregard");
  });
});
