import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, RouteError, type RouteDeps } from "../../src/router/route.ts";
import { metadataBlock } from "../../src/router/convention.ts";
import { readDecisionEntries } from "../../src/router/decision-log.ts";
import { pathsFor } from "../../src/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";
import type { ModelCall } from "../../src/router/model.ts";
import type { CreateSessionOptions } from "../../src/omnigent/client.ts";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-route-"));
  workspace = join(home, "project");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const NOW = new Date("2026-08-15T12:00:00.000Z");

const session = (overrides: Partial<PoolSession> & { id: string }): PoolSession => ({
  title: "subtitle pipeline",
  workspace: "/Users/felho/dev/craft",
  status: "idle",
  agent_name: "claude-native-ui",
  created_at: Math.floor(NOW.getTime() / 1000) - 3600,
  updated_at: Math.floor(NOW.getTime() / 1000) - 240,
  archived: false,
  host_id: "h1",
  pending_elicitations: 0,
  ...overrides,
});

const modelReturning = (raw: string): ModelCall => async () => ({ raw, latencyMs: 1234 });

function harness(overrides: Partial<RouteDeps> = {}) {
  const spoken: string[] = [];
  const messages: Array<{ id: string; text: string }> = [];
  const created: CreateSessionOptions[] = [];

  const deps: RouteDeps = {
    client: {
      listSessions: async () => [session({ id: "s1" })],
      postMessage: async (id: string, text: string) => {
        messages.push({ id, text });
        return { pendingId: null };
      },
      createSession: async (options: CreateSessionOptions) => {
        created.push(options);
        return { id: "conv_fresh" };
      },
      sessionItems: async () => [],
      interrupt: async () => {},
      deleteSession: async () => {},
      sessionState: async () => ({ status: "idle" as const, pending_inputs: [] }),
    },
    config: { ...DEFAULT_CONFIG, home_dir: home },
    paths: pathsFor(home),
    modelCall: modelReturning(
      JSON.stringify({ action: "continue", session_id: "s1", request: "do it", ack: "Passing it on." }),
    ),
    conventionText: "speak on finish",
    projectsRoot: home, // `workspace` below is a direct child, i.e. an offered placement
    projectDirs: ["craft"],
    speak: async (text: string) => void spoken.push(text),
    now: () => NOW,
    lockOptions: { pollMs: 5 },
    ...overrides,
  };

  return { deps, spoken, messages, created };
}

const logOf = () => readDecisionEntries(pathsFor(home).decisionLog, {});

describe("route — continue", () => {
  test("delivers the request and speaks the ack", async () => {
    const { deps, spoken, messages } = harness();
    const result = await route("and the other one too", deps);

    expect(result.decision.action).toBe("continue");
    expect(messages).toEqual([{ id: "s1", text: `${metadataBlock("s1")}\n\ndo it` }]);
    expect(spoken).toEqual(["Passing it on."]);
    expect(result.executed).toBe(true);
    expect(result.target_session_id).toBe("s1");
  });

  test("the decision entry is on disk before the ack starts playing", async () => {
    // A long playback queue may hold the ack for minutes (the lock ceiling is generous on
    // purpose since content-length speech exists); the next routing must not wait for the
    // ack to see this decision in its context.
    let entriesWhenAckSpoke = -1;
    const { deps } = harness({
      speak: async () => void (entriesWhenAckSpoke = logOf().length),
    });
    await route("and the other one too", deps);
    expect(entriesWhenAckSpoke).toBe(1);
  });

  test("logs the decision with everything needed to reconstruct it later", async () => {
    const { deps } = harness();
    await route("and the other one too", deps);

    const [entry] = logOf();
    expect(entry).toMatchObject({
      utterance: "and the other one too",
      target_session_id: "s1",
      executed: true,
      fallback: false,
      reachback: false,
      peeked: false,
      latency_ms: 1234,
      model: DEFAULT_CONFIG.router_model,
    });
    expect(entry!.context_digest).toContain("1 candidates");
  });
});

describe("route — new", () => {
  test("creates in the chosen workspace and prefixes the id block", async () => {
    const { deps, created, messages } = harness({
      modelCall: modelReturning(
        JSON.stringify({ action: "new", cwd: workspace, request: "summarise it", ack: "Starting." }),
      ),
    });
    const result = await route("summarise the readme", deps);

    expect(created[0]).toMatchObject({
      workspace,
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "speak on finish",
    });
    expect(messages[0]!.text).toContain("your session id is conv_fresh");
    expect(messages[0]!.text.endsWith("summarise it")).toBe(true);
    expect(result.target_session_id).toBe("conv_fresh");
  });

  test("the new session's id is what lands in the log, not the cwd", async () => {
    const { deps } = harness({
      modelCall: modelReturning(
        JSON.stringify({ action: "new", cwd: workspace, request: "r", ack: "Starting." }),
      ),
    });
    await route("x", deps);
    expect(logOf()[0]!.target_session_id).toBe("conv_fresh");
  });
});

describe("route — clarify", () => {
  test("speaks the question and touches nothing", async () => {
    const { deps, spoken, messages, created } = harness({
      modelCall: modelReturning(
        JSON.stringify({ action: "clarify", question: "Melyik projektről van szó?" }),
      ),
    });
    const result = await route("do the thing", deps);

    expect(spoken).toEqual(["Melyik projektről van szó?"]);
    expect(messages).toEqual([]);
    expect(created).toEqual([]);
    expect(result.executed).toBe(false);
    expect(result.fallback).toBe(false);
    expect(logOf()[0]!.executed).toBe(false);
  });
});

describe("route — the deterministic fallback", () => {
  const expectFallback = async (deps: RouteDeps, spoken: string[], reasonFragment: string) => {
    const result = await route("do the thing", deps);
    expect(result.fallback).toBe(true);
    expect(result.decision).toEqual({
      action: "clarify",
      question: DEFAULT_CONFIG.clarify_fallback_text,
    });
    expect(spoken).toEqual([DEFAULT_CONFIG.clarify_fallback_text]);
    expect(result.executed).toBe(false);
    const [entry] = logOf();
    expect(entry!.fallback).toBe(true);
    expect(entry!.fallback_reason).toContain(reasonFragment);
    return result;
  };

  test("model output that is not JSON", async () => {
    const { deps, spoken } = harness({ modelCall: modelReturning("I am not sure, honestly.") });
    await expectFallback(deps, spoken, "no JSON");
  });

  test("JSON that fails the C5 schema", async () => {
    const { deps, spoken } = harness({
      modelCall: modelReturning(JSON.stringify({ action: "continue", request: "r", ack: "a" })),
    });
    await expectFallback(deps, spoken, "schema");
  });

  test("a hallucinated session id", async () => {
    const { deps, spoken, messages } = harness({
      modelCall: modelReturning(
        JSON.stringify({ action: "continue", session_id: "conv_ghost", request: "r", ack: "a" }),
      ),
    });
    await expectFallback(deps, spoken, "conv_ghost");
    expect(messages).toEqual([]); // caught before any side effect
  });

  test("a path that does not exist", async () => {
    const { deps, spoken, created } = harness({
      modelCall: modelReturning(
        JSON.stringify({ action: "new", cwd: join(home, "no-such-dir"), request: "r", ack: "a" }),
      ),
    });
    await expectFallback(deps, spoken, "not an existing directory");
    expect(created).toEqual([]);
  });

  test("a model call that throws", async () => {
    const { deps, spoken } = harness({
      modelCall: async () => {
        throw new Error("claude -p exited 1");
      },
    });
    const result = await expectFallback(deps, spoken, "model call failed");
    expect(result.latency_ms).toBe(0);
  });

  test("a dispatch that fails after a sound decision", async () => {
    const { deps, spoken } = harness({
      client: {
        listSessions: async () => [session({ id: "s1" })],
        postMessage: async () => {
          throw new Error("502 from the runner");
        },
        createSession: async () => ({ id: "conv_fresh" }),
        sessionItems: async () => [],
        interrupt: async () => {},
        deleteSession: async () => {},
        sessionState: async () => ({ status: "idle" as const, pending_inputs: [] }),
      },
    });
    await expectFallback(deps, spoken, "dispatch failed");
  });

  test("a ledger lookup, which has no mechanism yet", async () => {
    const { deps, spoken } = harness({
      modelCall: modelReturning(JSON.stringify({ action: "lookup_ledger", query: "subtitle" })),
    });
    await expectFallback(deps, spoken, "ledger lookup");
  });

  test("the fallback never crashes and never guesses — exit is normal, pool untouched", async () => {
    const { deps, messages, created } = harness({ modelCall: modelReturning("nonsense") });
    await route("do the thing", deps);
    expect(messages).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe("route — hard failures stay hard", () => {
  test("an unreachable pool is a RouteError, not a spoken shrug", async () => {
    const { deps, spoken } = harness({
      client: {
        listSessions: async () => {
          throw new Error("ECONNREFUSED");
        },
        postMessage: async () => ({ pendingId: null }),
        createSession: async () => ({ id: "x" }),
        sessionItems: async () => [],
        interrupt: async () => {},
        deleteSession: async () => {},
        sessionState: async () => ({ status: "idle" as const, pending_inputs: [] }),
      },
    });
    await expect(route("do the thing", deps)).rejects.toThrow(RouteError);
    expect(spoken).toEqual([]);
    expect(logOf()).toEqual([]);
  });
});

describe("route — dry run", () => {
  test("decides and logs, but touches neither the pool nor the speakers", async () => {
    const { deps, spoken, messages } = harness({ dryRun: true });
    const result = await route("and the other one too", deps);

    expect(result.decision.action).toBe("continue");
    expect(result.spoken).toBe("Passing it on.");
    expect(messages).toEqual([]);
    expect(spoken).toEqual([]);
    expect(logOf()).toHaveLength(1);
    expect(logOf()[0]!.executed).toBe(false);
  });
});

describe("route — serialisation", () => {
  test("the route lock is taken and released", async () => {
    const lockDir = join(home, "state", "route.lock");
    let ticketsDuringCall = 0;
    const { deps } = harness({
      modelCall: async () => {
        ticketsDuringCall = readdirSync(lockDir).length;
        return { raw: JSON.stringify({ action: "clarify", question: "which?" }), latencyMs: 1 };
      },
    });

    await route("x", deps);
    expect(ticketsDuringCall).toBe(1);
    expect(readdirSync(lockDir)).toHaveLength(0);
  });

  test("two utterances run one after the other, never interleaved", async () => {
    const order: string[] = [];
    const makeDeps = (label: string) =>
      harness({
        modelCall: async () => {
          order.push(`in ${label}`);
          await new Promise((resolve) => setTimeout(resolve, 40));
          order.push(`out ${label}`);
          return { raw: JSON.stringify({ action: "clarify", question: "q" }), latencyMs: 1 };
        },
      }).deps;

    await Promise.all([route("first", makeDeps("A")), route("second", makeDeps("B"))]);

    expect(order).toHaveLength(4);
    expect(order[1]).toBe(`out ${order[0]!.slice(3)}`);
    expect(order[3]).toBe(`out ${order[2]!.slice(3)}`);
  });
});

describe("route — the spoken ledger feeds the context", () => {
  test("a session's last spoken line reaches the prompt", async () => {
    mkdirSync(join(home, "spoken"), { recursive: true });
    writeFileSync(
      join(home, "spoken", "2026-08-15.jsonl"),
      `${JSON.stringify({
        ts: "2026-08-15T11:56:00.000Z",
        session_id: "s1",
        text: "The subtitles are done.",
        voice: "Tünde",
        engine: "say",
      })}\n`,
      "utf8",
    );

    let seenPrompt = "";
    const { deps } = harness({
      modelCall: async (request) => {
        seenPrompt = request.user;
        return { raw: JSON.stringify({ action: "clarify", question: "q" }), latencyMs: 1 };
      },
    });
    await route("and the other one too", deps);

    expect(seenPrompt).toContain("The subtitles are done.");
    expect(seenPrompt).toContain("MOST RECENT INTERACTION: session s1");
  });
});
