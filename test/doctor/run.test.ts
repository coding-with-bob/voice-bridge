import { describe, expect, test } from "bun:test";
import { runDoctor, type DoctorDeps } from "../../src/doctor/run.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";
import { homedir } from "node:os";
import { join } from "node:path";

type StubClient = DoctorDeps["client"];

function stubClient(overrides: Partial<Record<keyof StubClient, unknown>> = {}): StubClient {
  const base = {
    health: async () => ({ ok: true, detail: "server reports status=ok" }),
    listHosts: async () => [{ host_id: "h1", name: "mac", status: "online" }],
    listAgents: async () => [{ id: "ag", name: "claude-native-ui", harness: "claude-native" }],
    listSessions: async () => [] as PoolSession[],
    createSession: async () => ({ id: "conv_smoke" }),
    postMessage: async () => {},
    sessionItems: async () => [{ id: "i", role: "assistant", text: "pong", created_at: 1 }],
    deleteSession: async () => {},
  };
  return { ...base, ...overrides } as StubClient;
}

const deps = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
  client: stubClient(),
  omnigentUrl: "http://127.0.0.1:6767",
  homeDir: "/Users/felho/bob",
  configSource: "file",
  conventionFile: join(homedir(), "bob", "CLAUDE.md"),
  readListenHosts: async () => ["127.0.0.1"],
  modelCall: async () => ({ raw: '{"action":"clarify","question":"ok"}', latencyMs: 900 }),
  routerModel: "claude-opus-5",
  sleep: async () => {},
  spawn: true,
  ...overrides,
});

const check = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((entry) => entry.name === name)!;

describe("runDoctor — a healthy platform", () => {
  test("every check passes and the report is green", async () => {
    const report = await runDoctor(deps());
    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.name)).toEqual([
      "config",
      "speech",
      "server",
      "bind",
      "host",
      "agent",
      "router",
      "spawn",
    ]);
  });

  test("the smoke session is cleaned up — it must not linger as a routing candidate", async () => {
    const deleted: string[] = [];
    const report = await runDoctor(
      deps({ client: stubClient({ deleteSession: async (id: string) => void deleted.push(id) }) }),
    );
    expect(deleted).toEqual(["conv_smoke"]);
    expect(check(report, "spawn").ok).toBe(true);
  });

  test("--quick skips the spawn smoke entirely", async () => {
    const report = await runDoctor(deps({ spawn: false }));
    expect(report.checks.map((entry) => entry.name)).not.toContain("spawn");
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor — every failure explains its fix", () => {
  test("server down", async () => {
    const report = await runDoctor(
      deps({
        client: stubClient({ health: async () => ({ ok: false, detail: "ECONNREFUSED" }) }),
      }),
    );
    expect(report.ok).toBe(false);
    expect(check(report, "server").hint).toContain("omnigent server");
  });

  test("a server bound beyond loopback fails the R-15 condition", async () => {
    const report = await runDoctor(deps({ readListenHosts: async () => ["0.0.0.0"] }));
    expect(check(report, "bind").ok).toBe(false);
    expect(check(report, "bind").detail).toContain("0.0.0.0");
    expect(check(report, "bind").hint).toContain("loopback");
  });

  /**
   * Regression: `lsof` lives in /usr/sbin, which a minimal PATH (Raycast, launchd) can omit.
   * The spawn threw straight out of the check and took the whole report down with it —
   * exactly what "every check runs even after one fails" exists to prevent.
   */
  test("an unrunnable bind probe is a failed check, not a crashed doctor", async () => {
    const report = await runDoctor(
      deps({
        readListenHosts: async () => {
          throw new Error('Executable not found in $PATH: "lsof"');
        },
      }),
    );
    expect(report.checks).toHaveLength(8);
    expect(check(report, "bind").ok).toBe(false);
    expect(check(report, "bind").detail).toContain("lsof");
    expect(check(report, "bind").hint).toContain("PATH");
    // The checks after it still ran.
    expect(check(report, "host").ok).toBe(true);
    expect(check(report, "spawn").ok).toBe(true);
  });

  test("nothing listening is reported as such, not as safely bound", async () => {
    const report = await runDoctor(deps({ readListenHosts: async () => [] }));
    expect(check(report, "bind").ok).toBe(false);
    // The fix is to start the server, not to go looking at bind configuration.
    expect(check(report, "bind").hint).toContain("omnigent server");
    expect(check(report, "bind").hint).not.toContain("R-15");
  });

  test("no online host", async () => {
    const report = await runDoctor(
      deps({
        client: stubClient({
          listHosts: async () => [{ host_id: "h1", name: "mac", status: "offline" }],
        }),
      }),
    );
    expect(check(report, "host").ok).toBe(false);
    expect(check(report, "host").hint).toContain("omnigent host");
  });

  test("no claude-native agent registered", async () => {
    const report = await runDoctor(
      deps({ client: stubClient({ listAgents: async () => [] }) }),
    );
    expect(check(report, "agent").ok).toBe(false);
  });

  test("a session that never answers", async () => {
    const report = await runDoctor(
      deps({ client: stubClient({ sessionItems: async () => [] }), smokeTimeoutMs: 30 }),
    );
    expect(check(report, "spawn").ok).toBe(false);
    expect(check(report, "spawn").detail).toContain("no reply");
  });

  test("a spawn that throws is a failed check, not a crashed doctor", async () => {
    const report = await runDoctor(
      deps({
        client: stubClient({
          createSession: async () => {
            throw new Error("no runner bound");
          },
        }),
      }),
    );
    expect(check(report, "spawn").ok).toBe(false);
    expect(check(report, "spawn").detail).toContain("no runner bound");
  });

  test("checks after a failure still run — one report, all the news at once", async () => {
    const report = await runDoctor(
      deps({ client: stubClient({ health: async () => ({ ok: false, detail: "down" }) }) }),
    );
    expect(report.checks).toHaveLength(8);
  });
});

describe("runDoctor — the router's own call", () => {
  test("a launcher that cannot authenticate is caught here, not at the microphone", async () => {
    const report = await runDoctor(
      deps({
        modelCall: async () => {
          throw new Error("claude -p exited 1: Not logged in · Please run /login");
        },
      }),
    );
    expect(check(report, "router").ok).toBe(false);
    expect(check(report, "router").detail).toContain("Not logged in");
    expect(check(report, "router").hint).toContain("Every utterance would fall back");
  });

  test("an answer that is not JSON fails the check too", async () => {
    const report = await runDoctor(
      deps({ modelCall: async () => ({ raw: "I am not sure, honestly.", latencyMs: 800 }) }),
    );
    expect(check(report, "router").ok).toBe(false);
    expect(check(report, "router").detail).toContain("not with JSON");
  });

  test("a healthy call reports the launcher and the model", async () => {
    const report = await runDoctor(deps());
    expect(check(report, "router").ok).toBe(true);
    expect(check(report, "router").detail).toContain("claude-opus-5");
  });
});

describe("runDoctor — slow but working", () => {
  test("a reply slower than the spike baseline passes with a warning hint", async () => {
    let elapsed = 0;
    const report = await runDoctor(
      deps({
        now: () => (elapsed += 6_000),
        client: stubClient(),
      }),
    );
    const spawn = check(report, "spawn");
    expect(spawn.ok).toBe(true);
    expect(spawn.hint).toContain("slower");
  });
});
