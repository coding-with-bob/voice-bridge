/**
 * `bob doctor` — the mandatory post-upgrade check the platform contract asks for.
 *
 * Every check runs even after one fails: a single report telling you everything that is
 * wrong beats three runs each revealing one more problem. Every failure carries the
 * command that fixes it.
 */
import { isLocalhostOnly } from "./bind.ts";
import { readConvention } from "../router/convention.ts";
import { claudeLauncher, extractJson, type ModelCall } from "../router/model.ts";
import { CLAUDE_NATIVE_HARNESS, type OmnigentClient } from "../omnigent/client.ts";

/** The spike baseline a fresh session met; slower than this is worth knowing about. */
const SPIKE_BASELINE_MS = 5_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 30_000;
const SMOKE_POLL_MS = 500;
const SMOKE_PROMPT = "Reply with exactly the word: pong";
const ROUTER_CHECK_TIMEOUT_MS = 60_000;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it — a failing check without a fix is just bad news. */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface DoctorDeps {
  client: Pick<
    OmnigentClient,
    | "health"
    | "listHosts"
    | "listAgents"
    | "listSessions"
    | "createSession"
    | "postMessage"
    | "sessionItems"
    | "deleteSession"
  >;
  omnigentUrl: string;
  homeDir: string;
  configSource: "file" | "defaults";
  /** Path to the CLAUDE.md carrying the C6 speak-on-finish convention. */
  conventionFile: string;
  readListenHosts: (port: number) => Promise<string[]>;
  /** Run the spawn smoke test (skipped by `--quick`). */
  spawn: boolean;
  /** The router's decision call, exercised the same way routing exercises it. */
  modelCall: ModelCall;
  routerModel: string;
  smokeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: CheckResult[] = [
    configCheck(deps),
    conventionCheck(deps),
    await serverCheck(deps),
    await bindCheck(deps),
    await hostCheck(deps),
    await agentCheck(deps),
    await routerCheck(deps),
  ];
  if (deps.spawn) checks.push(await spawnCheck(deps));

  return { ok: checks.every((check) => check.ok), checks };
}

function configCheck(deps: DoctorDeps): CheckResult {
  return {
    name: "config",
    ok: true,
    detail:
      deps.configSource === "file"
        ? `state home ${deps.homeDir}, defaults.yaml loaded`
        : `state home ${deps.homeDir}, no defaults.yaml — using baked-in defaults`,
  };
}

/**
 * Without the C6 convention the bridge still routes and never speaks back — a failure that
 * looks like nothing at all. Cheap to check, so it is checked.
 */
function conventionCheck(deps: DoctorDeps): CheckResult {
  try {
    const convention = readConvention(deps.conventionFile);
    return {
      name: "speech",
      ok: true,
      detail: `speak-on-finish convention loaded (${convention.length} characters)`,
    };
  } catch (error) {
    return {
      name: "speech",
      ok: false,
      detail: describe(error),
      hint: `Restore the C6 block in ${deps.conventionFile}; spawned sessions read it from there.`,
    };
  }
}

async function serverCheck(deps: DoctorDeps): Promise<CheckResult> {
  const health = await deps.client.health();
  return {
    name: "server",
    ok: health.ok,
    detail: `${deps.omnigentUrl}: ${health.detail}`,
    ...(health.ok ? {} : { hint: "Start it with `omnigent server --background`." }),
  };
}

async function bindCheck(deps: DoctorDeps): Promise<CheckResult> {
  const port = portOf(deps.omnigentUrl);

  let hosts: string[];
  try {
    hosts = await deps.readListenHosts(port);
  } catch (error) {
    // The probe shells out to `lsof`, which lives in /usr/sbin — a directory a minimal
    // PATH (Raycast, launchd) can omit. Letting that throw would take the whole report
    // down over one unrunnable check, which is the opposite of what this report is for.
    return {
      name: "bind",
      ok: false,
      detail: `could not probe port ${port}: ${describe(error)}`,
      hint: "The probe needs `lsof` on PATH — add /usr/sbin if you are running from a minimal environment.",
    };
  }

  const ok = isLocalhostOnly(hosts);
  if (hosts.length === 0) {
    // Nothing listening is a failure to verify the R-15 condition, but the fix is to start
    // the server — pointing at the bind configuration here would send the reader nowhere.
    return {
      name: "bind",
      ok: false,
      detail: `nothing is listening on port ${port}`,
      hint: "Nothing to check until the server runs — start it with `omnigent server --background`.",
    };
  }
  return {
    name: "bind",
    ok,
    detail: `port ${port} listening on ${hosts.join(", ")}`,
    ...(ok
      ? {}
      : {
          hint:
            "The server runs without API auth, so it must stay on loopback (R-15). " +
            "Check the server's bind configuration before using it.",
        }),
  };
}

async function hostCheck(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const hosts = await deps.client.listHosts();
    const online = hosts.filter((host) => host.status === "online");
    return {
      name: "host",
      ok: online.length > 0,
      detail:
        online.length > 0
          ? `${online.length} online: ${online.map((host) => host.name).join(", ")}`
          : `no online host (${hosts.length} registered)`,
      ...(online.length > 0 ? {} : { hint: "Start the host daemon with `omnigent host`." }),
    };
  } catch (error) {
    return {
      name: "host",
      ok: false,
      detail: describe(error),
      hint: "Start the host daemon with `omnigent host`.",
    };
  }
}

async function agentCheck(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const agents = await deps.client.listAgents();
    const agent = agents.find((candidate) => candidate.harness === CLAUDE_NATIVE_HARNESS);
    return {
      name: "agent",
      ok: agent !== undefined,
      detail:
        agent === undefined
          ? `no ${CLAUDE_NATIVE_HARNESS} agent among ${agents.length} registered`
          : `${agent.name} (${agent.id})`,
      ...(agent === undefined
        ? { hint: "The server ships this agent built in; a missing one means a broken install." }
        : {}),
    };
  } catch (error) {
    return { name: "agent", ok: false, detail: describe(error) };
  }
}

/**
 * The decision call, exercised exactly as routing exercises it.
 *
 * This check exists because of a failure it would have caught: `bob route` launched from a
 * bare environment (Raycast, launchd) fell back on every single utterance, because the
 * Claude Code launcher it used is only authenticated where the proxy environment was
 * inherited. Routing degraded politely and said nothing about why — the deterministic
 * fallback is designed not to shout — so nothing surfaced until someone read the log.
 * Doctor is the place that surfaces it.
 */
async function routerCheck(deps: DoctorDeps): Promise<CheckResult> {
  const launcher = claudeLauncher().join(" ");
  try {
    const response = await deps.modelCall({
      system: 'You are a JSON echo. Reply with exactly {"action":"clarify","question":"ok"} and nothing else.',
      user: "ping",
      model: deps.routerModel,
      timeoutMs: ROUTER_CHECK_TIMEOUT_MS,
    });
    const parsed = extractJson(response.raw);
    if (parsed === null) {
      return {
        name: "router",
        ok: false,
        detail: `${launcher} answered, but not with JSON: ${truncate(response.raw)}`,
        hint: "The decision call would fall back on every utterance. Check the model name in defaults.yaml.",
      };
    }
    return {
      name: "router",
      ok: true,
      detail: `${launcher} · ${deps.routerModel} · decided in ${response.latencyMs}ms`,
    };
  } catch (error) {
    return {
      name: "router",
      ok: false,
      detail: `${launcher}: ${describe(error)}`,
      hint: `Every utterance would fall back. Check that \`${launcher} -p\` runs authenticated from a bare shell.`,
    };
  }
}

/**
 * The real integration test: a session created, messaged and answering through the client
 * module alone. Its throwaway session is deleted afterwards — doctor cleans up after itself
 * so the pool never fills with smoke-test candidates.
 */
async function spawnCheck(deps: DoctorDeps): Promise<CheckResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;

  let sessionId: string | null = null;
  try {
    const started = now();
    const created = await deps.client.createSession({
      workspace: "/tmp",
      permissionMode: "bypassPermissions",
      title: "bob-doctor-smoke",
    });
    sessionId = created.id;
    await deps.client.postMessage(sessionId, SMOKE_PROMPT);

    const deadline = started + timeoutMs;
    let reply: string | null = null;
    while (reply === null && now() < deadline) {
      await sleep(SMOKE_POLL_MS);
      const items = await deps.client.sessionItems(sessionId);
      reply = items.filter((item) => item.role === "assistant").at(-1)?.text ?? null;
    }
    const elapsed = now() - started;

    if (reply === null) {
      return {
        name: "spawn",
        ok: false,
        detail: `session ${sessionId} created but gave no reply within ${timeoutMs}ms`,
        hint: "Check the host daemon and the Omnigent UI for a stuck session.",
      };
    }
    return {
      name: "spawn",
      ok: true,
      detail: `created, messaged and answered in ${elapsed}ms (${truncate(reply)})`,
      ...(elapsed > SPIKE_BASELINE_MS
        ? { hint: `slower than the ${SPIKE_BASELINE_MS}ms spike baseline — worth investigating` }
        : {}),
    };
  } catch (error) {
    return { name: "spawn", ok: false, detail: describe(error) };
  } finally {
    if (sessionId !== null) {
      await deps.client.deleteSession(sessionId).catch(() => {});
    }
  }
}

function portOf(url: string): number {
  try {
    const parsed = new URL(url);
    return Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  } catch {
    return 0;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}
