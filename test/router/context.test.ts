import { describe, expect, test } from "bun:test";
import { buildContext, type ContextInput } from "../../src/router/context.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";
import type { SpokenLogEntry } from "../../src/contracts/spoken-log.ts";
import type { InterruptionRecord } from "../../src/contracts/playback.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const minutesAgo = (minutes: number) => Math.floor(NOW.getTime() / 1000) - minutes * 60;
const daysAgo = (days: number) => Math.floor(NOW.getTime() / 1000) - days * 86_400;

const session = (overrides: Partial<PoolSession> & { id: string }): PoolSession => ({
  title: "a session",
  workspace: "/Users/sam/dev/website",
  status: "idle",
  agent_name: "claude-native-ui",
  created_at: minutesAgo(60),
  updated_at: minutesAgo(10),
  archived: false,
  host_id: "h1",
  pending_elicitations: 0,
  ...overrides,
});

const spoken = (session_id: string | null, text: string, minutes: number): SpokenLogEntry => ({
  ts: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
  session_id,
  text,
  voice: "Samantha",
  engine: "say",
});

const input = (overrides: Partial<ContextInput> = {}): ContextInput => ({
  sessions: [],
  spoken: [],
  dispatches: [],
  projectsRoot: "/Users/sam/dev",
  sessionModels: ["claude-opus-5", "claude-fable-5"],
  sessionModel: "claude-opus-5",
  projectDirs: ["website", "pipeline"],
  homeDir: "/Users/sam/bob",
  followupWindowMin: 30,
  candidateWindowDays: 14,
  now: NOW,
  ...overrides,
});

describe("candidate selection", () => {
  test("keeps sessions active inside the candidate window, newest first", () => {
    const context = buildContext(
      input({
        sessions: [
          session({ id: "old", updated_at: daysAgo(5) }),
          session({ id: "fresh", updated_at: minutesAgo(2) }),
        ],
      }),
    );
    expect(context.candidates.map((candidate) => candidate.id)).toEqual(["fresh", "old"]);
  });

  test("drops sessions that fell out of the candidate window", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "ancient", updated_at: daysAgo(30) })] }),
    );
    expect(context.candidates).toEqual([]);
  });

  test("drops archived sessions", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "shelved", archived: true })] }),
    );
    expect(context.candidates).toEqual([]);
  });

  test("drops failed sessions — they cannot accept a message", () => {
    const context = buildContext(input({ sessions: [session({ id: "dead", status: "failed" })] }));
    expect(context.candidates).toEqual([]);
  });

  test("keeps waiting sessions — one parked on a question is a likely target for 'yes, do it'", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "asking", status: "waiting" })] }),
    );
    expect(context.candidates[0]!.status).toBe("waiting");
  });

  test("falls back to created_at when a session was never updated", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "new", updated_at: null, created_at: minutesAgo(5) })] }),
    );
    expect(context.candidates[0]!.minutes_since_active).toBe(5);
  });

  test("carries the metadata routing decides on", () => {
    const context = buildContext(
      input({
        sessions: [
          session({ id: "s1", title: "subtitle pipeline", workspace: "/Users/sam/dev/website" }),
        ],
      }),
    );
    expect(context.candidates[0]).toMatchObject({
      id: "s1",
      title: "subtitle pipeline",
      workspace: "/Users/sam/dev/website",
      status: "idle",
      minutes_since_active: 10,
    });
  });
});

describe("spoken tails", () => {
  test("attaches the last two spoken lines of each session, newest last", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" })],
        spoken: [
          spoken("s1", "first", 30),
          spoken("s1", "second", 20),
          spoken("s1", "third", 10),
          spoken("other", "not mine", 5),
        ],
      }),
    );
    expect(context.candidates[0]!.spoken_tail).toEqual(["second", "third"]);
  });

  test("a session that never spoke has an empty tail", () => {
    const context = buildContext(input({ sessions: [session({ id: "s1" })] }));
    expect(context.candidates[0]!.spoken_tail).toEqual([]);
  });

  test("sessionless lines belong to nobody", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "s1" })], spoken: [spoken(null, "an ack", 5)] }),
    );
    expect(context.candidates[0]!.spoken_tail).toEqual([]);
  });
});

describe("most recent interaction — derived, never stored", () => {
  test("the latest spoken line wins when it is the most recent event", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" }), session({ id: "s2" })],
        spoken: [spoken("s1", "older", 20), spoken("s2", "newer", 5)],
      }),
    );
    expect(context.most_recent).toMatchObject({
      session_id: "s2",
      kind: "spoken",
      minutes_ago: 5,
      within_followup_window: true,
    });
  });

  test("a dispatch counts as an interaction even when nothing was spoken back yet", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" }), session({ id: "s2" })],
        spoken: [spoken("s1", "spoke", 20)],
        dispatches: [
          { session_id: "s2", ts: new Date(NOW.getTime() - 3 * 60_000).toISOString() },
        ],
      }),
    );
    expect(context.most_recent).toMatchObject({ session_id: "s2", kind: "dispatch" });
  });

  test("outside the follow-up window it is reported but flagged", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "s1" })], spoken: [spoken("s1", "long ago", 90)] }),
    );
    expect(context.most_recent).toMatchObject({
      session_id: "s1",
      minutes_ago: 90,
      within_followup_window: false,
    });
  });

  test("an interaction with a session no longer in the pool is not offered as a target", () => {
    const context = buildContext(input({ sessions: [], spoken: [spoken("deleted", "gone", 2)] }));
    expect(context.most_recent).toBeNull();
  });

  test("no history at all means no most-recent interaction", () => {
    expect(buildContext(input({ sessions: [session({ id: "s1" })] })).most_recent).toBeNull();
  });
});

describe("the barge-in bias is only offered while it is fresh", () => {
  const interruption = (minutes: number, sessionId: string | null = "s1"): InterruptionRecord => ({
    ts: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    session_id: sessionId,
    answer_id: "a-1",
    interrupted_text: "The half that was never heard.",
    unplayed_texts: [],
  });

  const dispatch = (session_id: string, minutes: number) => ({
    ts: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    session_id,
  });

  test("a recent cut to an addressable session is offered", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "s1" })], interruption: interruption(1) }),
    );
    expect(context.interruption?.interrupted_text).toBe("The half that was never heard.");
    expect(context.digest).toContain("barge-in");
  });

  test("an hour-old barge-in must not haunt an unrelated request", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" })],
        followupWindowMin: 30,
        interruption: interruption(60),
      }),
    );
    expect(context.interruption).toBeNull();
    expect(context.digest).not.toContain("barge-in");
  });

  test("a dispatch after the cut has already consumed it — the bias is for the next utterance", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" })],
        interruption: interruption(5),
        dispatches: [dispatch("s1", 2)],
      }),
    );
    expect(context.interruption).toBeNull();
  });

  test("a dispatch from before the cut leaves the bias standing", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" })],
        interruption: interruption(2),
        dispatches: [dispatch("s1", 9)],
      }),
    );
    expect(context.interruption).not.toBeNull();
  });

  test("a cut to a session that has left the pool is not offered — it cannot be addressed", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "s2" })], interruption: interruption(1, "s1") }),
    );
    expect(context.interruption).toBeNull();
  });

  test("a sessionless cut — an interrupted router ack — biases nothing", () => {
    const context = buildContext(
      input({ sessions: [session({ id: "s1" })], interruption: interruption(1, null) }),
    );
    expect(context.interruption).toBeNull();
  });

  test("no interruption at all is the ordinary case", () => {
    expect(buildContext(input({ sessions: [session({ id: "s1" })] })).interruption).toBeNull();
  });
});

describe("digest", () => {
  test("summarises what the model was shown, for the decision log", () => {
    const context = buildContext(
      input({
        sessions: [session({ id: "s1" }), session({ id: "s2" })],
        spoken: [spoken("s1", "hello", 4)],
      }),
    );
    expect(context.digest).toContain("2 candidates");
    expect(context.digest).toContain("s1");
    expect(context.digest).toContain("4m ago");
  });

  test("says so plainly when the pool is empty", () => {
    expect(buildContext(input()).digest).toContain("0 candidates");
    expect(buildContext(input()).digest).toContain("no recent interaction");
  });
});
