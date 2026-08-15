import { describe, expect, test } from "bun:test";
import { runGc, type GcDeps } from "../../src/gc/run.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const hoursAgo = (hours: number) => Math.floor(NOW.getTime() / 1000) - hours * 3600;

const session = (overrides: Partial<PoolSession> & { id: string }): PoolSession => ({
  title: "a session",
  workspace: "/Users/felho/dev/craft",
  status: "idle",
  agent_name: "claude-native-ui",
  created_at: hoursAgo(10),
  updated_at: hoursAgo(10),
  archived: false,
  host_id: "h1",
  pending_elicitations: 0,
  ...overrides,
});

function harness(sessions: PoolSession[], options: { dryRun?: boolean; fail?: string } = {}) {
  const stopped: string[] = [];
  const deps: GcDeps = {
    client: {
      listSessions: async () => sessions,
      stopSession: async (id: string) => {
        if (options.fail === id) throw new Error("runner refused");
        stopped.push(id);
      },
    },
    idleHours: 3,
    dryRun: options.dryRun ?? false,
    now: () => NOW,
  };
  return { deps, stopped };
}

describe("runGc — what it sweeps", () => {
  test("stops a session idle beyond the threshold", async () => {
    const { deps, stopped } = harness([session({ id: "old", updated_at: hoursAgo(5) })]);
    const result = await runGc(deps);

    expect(stopped).toEqual(["old"]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ session_id: "old", stopped: true, dry_run: false });
    expect(result.entries[0]!.idle_hours).toBeCloseTo(5, 1);
  });

  test("leaves a session inside the threshold alone", async () => {
    const { deps, stopped } = harness([session({ id: "recent", updated_at: hoursAgo(1) })]);
    const result = await runGc(deps);
    expect(stopped).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  test("never touches a running session, however long it has been running", async () => {
    const { deps, stopped } = harness([
      session({ id: "working", status: "running", updated_at: hoursAgo(20) }),
    ]);
    await runGc(deps);
    expect(stopped).toEqual([]);
  });

  test("never touches a session waiting on a human", async () => {
    const { deps, stopped } = harness([
      session({ id: "asking", status: "waiting", updated_at: hoursAgo(20) }),
    ]);
    await runGc(deps);
    expect(stopped).toEqual([]);
  });

  test("skips archived sessions", async () => {
    const { deps, stopped } = harness([
      session({ id: "shelved", archived: true, updated_at: hoursAgo(20) }),
    ]);
    await runGc(deps);
    expect(stopped).toEqual([]);
  });

  test("falls back to created_at for a session never updated", async () => {
    const { deps, stopped } = harness([
      session({ id: "born-old", updated_at: null, created_at: hoursAgo(9) }),
    ]);
    await runGc(deps);
    expect(stopped).toEqual(["born-old"]);
  });

  test("sweeps every eligible session in one pass", async () => {
    const { deps, stopped } = harness([
      session({ id: "a", updated_at: hoursAgo(4) }),
      session({ id: "b", updated_at: hoursAgo(1) }),
      session({ id: "c", updated_at: hoursAgo(30) }),
    ]);
    const result = await runGc(deps);
    expect(stopped).toEqual(["a", "c"]);
    expect(result.scanned).toBe(3);
  });
});

describe("runGc — dry run", () => {
  test("reports what it would stop without stopping anything", async () => {
    const { deps, stopped } = harness([session({ id: "old", updated_at: hoursAgo(5) })], {
      dryRun: true,
    });
    const result = await runGc(deps);

    expect(stopped).toEqual([]);
    expect(result.entries[0]).toMatchObject({ session_id: "old", stopped: false, dry_run: true });
  });
});

describe("runGc — failures", () => {
  test("a session that refuses to stop is recorded, and the sweep continues", async () => {
    const { deps, stopped } = harness(
      [session({ id: "stubborn", updated_at: hoursAgo(5) }), session({ id: "fine", updated_at: hoursAgo(5) })],
      { fail: "stubborn" },
    );
    const result = await runGc(deps);

    expect(stopped).toEqual(["fine"]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ session_id: "stubborn", stopped: false });
    expect(result.entries[0]!.error).toContain("runner refused");
    expect(result.entries[1]).toMatchObject({ session_id: "fine", stopped: true });
  });
});
