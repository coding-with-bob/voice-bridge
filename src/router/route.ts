/**
 * `bob route` — one utterance in, one dispatch out, then exit.
 *
 * No daemon and no SSE: the router decides, delivers, acknowledges and dies. Watching for
 * the result is the session's job — it speaks for itself through `bobsay`.
 *
 * The invariant that shapes the error handling: **the router never guesses and never
 * crashes into silence.** A model that times out, answers nonsense, names a session that
 * does not exist, or a dispatch that fails — all of them land on the same deterministic
 * fallback, which is a spoken question, logged with its reason. The only failures that stay
 * hard are setup failures (no pool, no convention), because those need a human, not a retry.
 */
import { join } from "node:path";
import type { BobPaths } from "../config/load.ts";
import type { BobConfig } from "../contracts/config.ts";
import type { RouterDecision, DecisionLogEntry } from "../contracts/decision.ts";
import { parseRouterDecision } from "../contracts/decision.ts";
import type { OmnigentClient } from "../omnigent/client.ts";
import { acquireLock, type LockOptions } from "../say/lock.ts";
import { buildContext, type RoutingContext } from "./context.ts";
import { appendDecisionEntry, dispatchEvents, readDecisionEntries } from "./decision-log.ts";
import { checkExecutable, executeDecision, normalizeDecision } from "./execute.ts";
import { readSpokenEntries } from "./ledger.ts";
import { extractJson, type ModelCall } from "./model.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";

/** Own-tool sessions run without approval friction, per D10. */
export const PERMISSION_MODE = "bypassPermissions";
const MODEL_TIMEOUT_MS = 45_000;
const DECISION_HISTORY_LIMIT = 200;

/** A setup problem a human has to fix: routing cannot proceed and a retry will not help. */
export class RouteError extends Error {
  override name = "RouteError";
}

export interface RouteDeps {
  client: Pick<OmnigentClient, "listSessions" | "postMessage" | "createSession">;
  config: BobConfig;
  paths: BobPaths;
  modelCall: ModelCall;
  conventionText: string;
  projectsRoot: string;
  projectDirs: string[];
  /** Speaks one sentence out loud; sessionless, so the recency derivation ignores it. */
  speak: (text: string) => Promise<void>;
  warn?: (message: string) => void;
  now?: () => Date;
  /** Decide and log, but touch neither the pool nor the speakers. */
  dryRun?: boolean;
  lockOptions?: LockOptions;
}

export interface RouteResult {
  decision: RouterDecision;
  executed: boolean;
  target_session_id: string | null;
  fallback: boolean;
  fallback_reason?: string;
  /** What was said out loud (or would have been, on a dry run). */
  spoken: string;
  latency_ms: number;
  context_digest: string;
}

export async function route(utterance: string, deps: RouteDeps): Promise<RouteResult> {
  const now = deps.now ?? (() => new Date());
  const lock = await acquireLock(join(deps.config.home_dir, "state", "route.lock"), {
    ...deps.lockOptions,
  });
  try {
    return await routeUnderLock(utterance, deps, now);
  } finally {
    lock.release();
  }
}

async function routeUnderLock(
  utterance: string,
  deps: RouteDeps,
  now: () => Date,
): Promise<RouteResult> {
  const context = await gatherContext(deps, now());
  const attempt = await decide(utterance, context, deps, now());

  let decision = attempt.decision;
  let fallback = attempt.fallbackReason !== undefined;
  let fallbackReason = attempt.fallbackReason;
  let executed = false;
  let targetSessionId: string | null = null;

  if (!fallback && deps.dryRun !== true) {
    try {
      const outcome = await executeDecision(decision, {
        client: deps.client,
        conventionText: deps.conventionText,
        permissionMode: PERMISSION_MODE,
      });
      executed = outcome.executed;
      targetSessionId = outcome.targetSessionId;
    } catch (error) {
      // The decision was sound; delivering it was not. Same fallback, honest reason.
      decision = fallbackDecision(deps.config);
      fallback = true;
      fallbackReason = `dispatch failed: ${describe(error)}`;
    }
  }

  const spoken = spokenTextOf(decision);
  if (deps.dryRun !== true) {
    try {
      await deps.speak(spoken);
    } catch (error) {
      // The dispatch already happened; losing the ack must not lose the log entry too.
      (deps.warn ?? console.error)(`bob route: could not speak the ack: ${describe(error)}`);
    }
  }

  const entry: DecisionLogEntry = {
    ts: now().toISOString(),
    utterance,
    context_digest: context.digest,
    decision,
    latency_ms: attempt.latencyMs,
    model: deps.config.router_model,
    target_session_id: targetSessionId,
    executed,
    reachback: false, // ledger reach-back arrives in M4
    peeked: false, // tier-3 peek arrives in M4
    fallback,
    ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
  };
  appendDecisionEntry(deps.paths.decisionLog, entry);

  return {
    decision,
    executed,
    target_session_id: targetSessionId,
    fallback,
    ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
    spoken,
    latency_ms: attempt.latencyMs,
    context_digest: context.digest,
  };
}

async function gatherContext(deps: RouteDeps, now: Date): Promise<RoutingContext> {
  let sessions;
  try {
    sessions = await deps.client.listSessions();
  } catch (error) {
    throw new RouteError(
      `Cannot reach the session pool at ${deps.config.omnigent_url}: ${describe(error)}. ` +
        `Run \`bob doctor\` — routing needs the platform up.`,
    );
  }

  const spoken = readSpokenEntries(deps.config.home_dir, {
    sinceDays: deps.config.candidate_window_days,
    now,
  });
  const dispatches = dispatchEvents(
    readDecisionEntries(deps.paths.decisionLog, { limit: DECISION_HISTORY_LIMIT }),
  );

  return buildContext({
    sessions,
    spoken,
    dispatches,
    projectsRoot: deps.projectsRoot,
    projectDirs: deps.projectDirs,
    homeDir: deps.config.home_dir,
    followupWindowMin: deps.config.followup_window_min,
    candidateWindowDays: deps.config.candidate_window_days,
    now,
  });
}

interface Attempt {
  decision: RouterDecision;
  latencyMs: number;
  /** Set when the deterministic fallback replaced the model's answer. */
  fallbackReason?: string;
}

async function decide(
  utterance: string,
  context: RoutingContext,
  deps: RouteDeps,
  now: Date,
): Promise<Attempt> {
  const fallbackWith = (reason: string, latencyMs: number): Attempt => ({
    decision: fallbackDecision(deps.config),
    latencyMs,
    fallbackReason: reason,
  });

  let response;
  try {
    response = await deps.modelCall({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(context, utterance, now),
      model: deps.config.router_model,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  } catch (error) {
    return fallbackWith(`model call failed: ${describe(error)}`, 0);
  }

  const raw = extractJson(response.raw);
  if (raw === null) {
    return fallbackWith("model returned no JSON object", response.latencyMs);
  }

  const parsed = parseRouterDecision(raw);
  if (!parsed.ok) {
    return fallbackWith(`decision failed the schema (${parsed.reason})`, response.latencyMs);
  }

  const decision = normalizeDecision(parsed.decision);
  const executable = checkExecutable(decision, {
    candidateIds: new Set(context.candidates.map((candidate) => candidate.id)),
  });
  if (!executable.ok) {
    return fallbackWith(`decision is not executable: ${executable.reason}`, response.latencyMs);
  }

  return { decision, latencyMs: response.latencyMs };
}

function fallbackDecision(config: BobConfig): RouterDecision {
  return { action: "clarify", question: config.clarify_fallback_text };
}

function spokenTextOf(decision: RouterDecision): string {
  switch (decision.action) {
    case "continue":
    case "new":
      return decision.ack;
    case "clarify":
      return decision.question;
    case "lookup_ledger":
      return decision.query; // unreachable: a lookup never survives executability in M3
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
