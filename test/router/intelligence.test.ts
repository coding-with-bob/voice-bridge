/**
 * M4: the two rounds the router is allowed to ask for, and the tagging that makes
 * reach-backs visible afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, type RouteDeps } from "../../src/router/route.ts";
import { readDecisionEntries } from "../../src/router/decision-log.ts";
import { pathsFor } from "../../src/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";
import { fetchPeekExtracts } from "../../src/router/peek.ts";
import { buildLedgerMatches } from "../../src/router/context.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";
import type { SpokenLogEntry } from "../../src/contracts/spoken-log.ts";
import type { CreateSessionOptions } from "../../src/omnigent/client.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-m4-"));
  mkdirSync(join(home, "spoken"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NOW = new Date("2026-08-15T12:00:00.000Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const daysAgo = (days: number) => seconds(NOW) - days * 86_400;

const session = (overrides: Partial<PoolSession> & { id: string }): PoolSession => ({
  title: "a session",
  workspace: "/Users/felho/dev/craft",
  status: "idle",
  agent_name: "claude-native-ui",
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  archived: false,
  host_id: "h1",
  pending_elicitations: 0,
  ...overrides,
});

function writeLedger(day: string, entries: Array<Partial<SpokenLogEntry> & { session_id: string; text: string }>) {
  const lines = entries.map((entry) =>
    JSON.stringify({
      ts: `${day}T10:00:00.000Z`,
      voice: "Tünde",
      engine: "say",
      ...entry,
    }),
  );
  writeFileSync(join(home, "spoken", `${day}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** A model that answers a scripted sequence, one entry per round. */
function scriptedModel(answers: unknown[]) {
  const prompts: string[] = [];
  let round = 0;
  const call = async (request: { user: string }) => {
    prompts.push(request.user);
    const answer = answers[Math.min(round, answers.length - 1)];
    round += 1;
    return { raw: JSON.stringify(answer), latencyMs: 100 };
  };
  return { call, prompts, rounds: () => round };
}

function harness(options: {
  sessions: PoolSession[];
  answers: unknown[];
  items?: Record<string, Array<{ id: string; role: string; text: string; created_at: number }>>;
}) {
  const model = scriptedModel(options.answers);
  const messages: Array<{ id: string; text: string }> = [];
  const itemRequests: string[] = [];

  const deps: RouteDeps = {
    client: {
      listSessions: async () => options.sessions,
      postMessage: async (id: string, text: string) => void messages.push({ id, text }),
      createSession: async (_options: CreateSessionOptions) => ({ id: "conv_fresh" }),
      sessionItems: async (id: string) => {
        itemRequests.push(id);
        return options.items?.[id] ?? [];
      },
    },
    config: { ...DEFAULT_CONFIG, home_dir: home },
    paths: pathsFor(home),
    modelCall: model.call,
    conventionText: "speak on finish",
    projectsRoot: "/Users/felho/dev",
    projectDirs: ["craft"],
    speak: async () => {},
    now: () => NOW,
    lockOptions: { pollMs: 5 },
  };
  return { deps, model, messages, itemRequests };
}

const logOf = () => readDecisionEntries(pathsFor(home).decisionLog, {});

describe("tier-3 peek", () => {
  const twoCandidates = [session({ id: "s1", title: "subtitles" }), session({ id: "s2", title: "captions" })];

  const torn = {
    action: "continue",
    session_id: "s1",
    request: "do it",
    ack: "ok",
    candidates: [
      { session_id: "s1", reason: "mentions subtitles" },
      { session_id: "s2", reason: "mentions captions" },
    ],
  };

  test("candidates trigger exactly one extra round, then the router decides", async () => {
    const { deps, model } = harness({
      sessions: twoCandidates,
      answers: [torn, { action: "continue", session_id: "s2", request: "do it", ack: "Sent to captions." }],
    });
    const result = await route("the timing one", deps);

    expect(model.rounds()).toBe(2);
    expect(result.peeked).toBe(true);
    expect(result.target_session_id).toBe("s2");
    expect(logOf()[0]!.peeked).toBe(true);
  });

  test("the extracts of exactly the shortlisted sessions reach the second prompt", async () => {
    const { deps, model, itemRequests } = harness({
      sessions: twoCandidates,
      answers: [torn, { action: "continue", session_id: "s1", request: "do it", ack: "ok" }],
      items: {
        s1: [{ id: "a", role: "assistant", text: "Subtitle timing fixed.", created_at: 1 }],
        s2: [{ id: "b", role: "assistant", text: "Captions exported.", created_at: 1 }],
      },
    });
    await route("the timing one", deps);

    expect(itemRequests.sort()).toEqual(["s1", "s2"]);
    expect(model.prompts[1]).toContain("TRANSCRIPT EXTRACTS");
    expect(model.prompts[1]).toContain("Subtitle timing fixed.");
    expect(model.prompts[1]).toContain("Captions exported.");
    expect(model.prompts[0]).not.toContain("TRANSCRIPT EXTRACTS");
  });

  test("a second torn answer does not buy a second peek — the decision stands", async () => {
    const { deps, model } = harness({ sessions: twoCandidates, answers: [torn, torn] });
    const result = await route("the timing one", deps);

    expect(model.rounds()).toBe(2);
    expect(result.fallback).toBe(false);
    expect(result.target_session_id).toBe("s1");
  });

  test("a single candidate is not being torn, so no peek happens", async () => {
    const { deps, model } = harness({
      sessions: twoCandidates,
      answers: [{ ...torn, candidates: [{ session_id: "s1", reason: "obvious" }] }],
    });
    const result = await route("x", deps);

    expect(model.rounds()).toBe(1);
    expect(result.peeked).toBe(false);
  });

  test("a transcript that cannot be read still lets the round finish", async () => {
    const model = scriptedModel([torn, { action: "continue", session_id: "s1", request: "r", ack: "ok" }]);
    const { deps } = harness({ sessions: twoCandidates, answers: [] });
    deps.modelCall = model.call;
    deps.client = {
      ...deps.client,
      sessionItems: async () => {
        throw new Error("500 from the runner");
      },
    };
    const result = await route("x", deps);

    expect(result.peeked).toBe(true);
    expect(result.fallback).toBe(false);
    expect(model.prompts[1]).toContain("(nothing readable in this transcript)");
  });
});

describe("ledger reach-back", () => {
  // Deliberately out of the candidate window: this is the case the window would cut off.
  const july = session({ id: "july", title: "old work", updated_at: daysAgo(40), created_at: daysAgo(41) });
  const recent = session({ id: "recent", title: "today's thing" });

  beforeEach(() => {
    writeLedger("2026-07-08", [{ session_id: "july", text: "The subtitle pipeline is finally done." }]);
    writeLedger("2026-08-15", [{ session_id: "recent", text: "Invoices exported." }]);
  });

  test("a lookup surfaces a session the candidate window had hidden", async () => {
    const { deps, model } = harness({
      sessions: [july, recent],
      answers: [
        { action: "lookup_ledger", query: "subtitle" },
        { action: "continue", session_id: "july", request: "what did we decide there?", ack: "Reaching back." },
      ],
    });
    const result = await route("that subtitle thing from July", deps);

    expect(model.rounds()).toBe(2);
    expect(model.prompts[0]).not.toContain("id: july");
    expect(model.prompts[1]).toContain("FOUND IN THE SPOKEN LEDGER");
    expect(model.prompts[1]).toContain("id: july");
    expect(model.prompts[1]).toContain('matched: "The subtitle pipeline is finally done."');
    expect(result.target_session_id).toBe("july");
  });

  test("the reach-back is tagged, with the query as its reason", async () => {
    const { deps } = harness({
      sessions: [july, recent],
      answers: [
        { action: "lookup_ledger", query: "subtitle" },
        { action: "continue", session_id: "july", request: "r", ack: "a" },
      ],
    });
    const result = await route("that subtitle thing", deps);

    expect(result.reachback).toBe(true);
    expect(result.reachback_reason).toContain("subtitle");
    const [entry] = logOf();
    expect(entry!.reachback).toBe(true);
    expect(entry!.reachback_reason).toContain("subtitle");
  });

  test("continuing a session inside the window is not a reach-back", async () => {
    const { deps } = harness({
      sessions: [july, recent],
      answers: [{ action: "continue", session_id: "recent", request: "r", ack: "a" }],
    });
    const result = await route("the invoices", deps);
    expect(result.reachback).toBe(false);
    expect(logOf()[0]!.reachback_reason).toBeUndefined();
  });

  test("a lookup that finds nothing still lets the router answer", async () => {
    const { deps, model } = harness({
      sessions: [recent],
      answers: [
        { action: "lookup_ledger", query: "nothing matches this" },
        { action: "clarify", question: "Melyikre gondolsz?" },
      ],
    });
    const result = await route("that thing", deps);

    expect(model.rounds()).toBe(2);
    expect(result.fallback).toBe(false);
    expect(result.spoken).toBe("Melyikre gondolsz?");
  });

  test("a second lookup in one invocation becomes the deterministic fallback", async () => {
    const { deps, model } = harness({
      sessions: [july, recent],
      answers: [
        { action: "lookup_ledger", query: "subtitle" },
        { action: "lookup_ledger", query: "captions" },
      ],
    });
    const result = await route("that thing", deps);

    expect(model.rounds()).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.fallback_reason).toContain("second ledger lookup");
    expect(result.spoken).toBe(DEFAULT_CONFIG.clarify_fallback_text);
  });

  test("a router that never settles falls back rather than looping", async () => {
    const { deps, model } = harness({
      sessions: [session({ id: "s1" }), session({ id: "s2" })],
      answers: [
        {
          action: "continue",
          session_id: "s1",
          request: "r",
          ack: "a",
          candidates: [
            { session_id: "s1", reason: "one" },
            { session_id: "s2", reason: "two" },
          ],
        },
        { action: "lookup_ledger", query: "anything" },
        { action: "lookup_ledger", query: "again" },
      ],
    });
    const result = await route("x", deps);

    expect(model.rounds()).toBe(3);
    expect(result.fallback).toBe(true);
  });
});

describe("buildLedgerMatches", () => {
  const sessions = [session({ id: "july", updated_at: daysAgo(40) }), session({ id: "gone", updated_at: daysAgo(40) })];

  const hit = (session_id: string | null, text: string, score = 1) => ({
    entry: {
      ts: "2026-07-08T10:00:00.000Z",
      session_id,
      text,
      voice: "Tünde",
      engine: "say",
    } as SpokenLogEntry,
    score,
  });

  test("maps hits onto the sessions that still exist", () => {
    const matches = buildLedgerMatches({
      hits: [hit("july", "subtitles done"), hit("vanished", "also subtitles")],
      sessions,
      alreadyOffered: new Set(),
      now: NOW,
    });
    expect(matches.map((match) => match.id)).toEqual(["july"]);
    expect(matches[0]!.matched_lines).toEqual(["subtitles done"]);
  });

  test("skips sessions already on the candidate list — no duplicates in the prompt", () => {
    const matches = buildLedgerMatches({
      hits: [hit("july", "subtitles done")],
      sessions,
      alreadyOffered: new Set(["july"]),
      now: NOW,
    });
    expect(matches).toEqual([]);
  });

  test("a sessionless line surfaces nothing", () => {
    const matches = buildLedgerMatches({
      hits: [hit(null, "x")],
      sessions,
      alreadyOffered: new Set(),
      now: NOW,
    });
    expect(matches).toEqual([]);
  });
});

describe("fetchPeekExtracts", () => {
  const client = {
    sessionItems: async (id: string) => [
      { id: `${id}-1`, role: "user", text: "first", created_at: 1 },
      { id: `${id}-2`, role: "assistant", text: "second", created_at: 2 },
    ],
  };

  test("keeps the shortlist to two", async () => {
    const extracts = await fetchPeekExtracts(client, ["a", "b", "c"]);
    expect(extracts.map((extract) => extract.session_id)).toEqual(["a", "b"]);
  });

  test("de-duplicates a repeated id", async () => {
    const extracts = await fetchPeekExtracts(client, ["a", "a"]);
    expect(extracts).toHaveLength(1);
  });

  test("returns turns in the order they were spoken", async () => {
    const [extract] = await fetchPeekExtracts(client, ["a"]);
    expect(extract!.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
  });

  test("truncates a long turn rather than flooding the prompt", async () => {
    const wordy = {
      sessionItems: async () => [
        { id: "1", role: "assistant", text: "x".repeat(2000), created_at: 1 },
      ],
    };
    const [extract] = await fetchPeekExtracts(wordy, ["a"]);
    expect(extract!.turns[0]!.text.length).toBeLessThan(500);
    expect(extract!.turns[0]!.text.endsWith("…")).toBe(true);
  });
});
