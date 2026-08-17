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
import { candidatesOf, correctionTarget, parseRouterDecision } from "../contracts/decision.ts";
import type { OmnigentClient } from "../omnigent/client.ts";
import type { PoolSession } from "../omnigent/parse.ts";
import { acquireLock, type LockOptions } from "../say/lock.ts";
import {
  addressableIds,
  buildContext,
  buildLedgerMatches,
  type RoutingContext,
} from "./context.ts";
import { appendDecisionEntry, dispatchEvents, readDecisionEntries } from "./decision-log.ts";
import { checkExecutable, executeDecision, normalizeDecision } from "./execute.ts";
import { grepSpokenLedger, readSpokenEntries } from "./ledger.ts";
import { fetchPeekExtracts, PEEK_CANDIDATE_LIMIT } from "./peek.ts";
import {
  disregardTextFor,
  repairPrevious,
  UNWITHDRAWN,
  WITHDRAWN,
  type RepairOutcome,
  type RepairResult,
} from "./repair.ts";
import { extractJson, type ModelCall } from "./model.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.ts";

/** Own-tool sessions run without approval friction, per D10. */
export const PERMISSION_MODE = "bypassPermissions";
const MODEL_TIMEOUT_MS = 45_000;
/** Initial ask, plus at most one ledger-lookup round and one peek round. */
const MAX_MODEL_ROUNDS = 3;
const DECISION_HISTORY_LIMIT = 200;

/** A setup problem a human has to fix: routing cannot proceed and a retry will not help. */
export class RouteError extends Error {
  override name = "RouteError";
}

export interface RouteDeps {
  client: Pick<
    OmnigentClient,
    | "listSessions"
    | "postMessage"
    | "createSession"
    | "sessionItems"
    | "interrupt"
    | "deleteSession"
    | "sessionState"
  >;
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
  /** A `continue` to a session the candidate window had hidden. */
  reachback: boolean;
  reachback_reason?: string;
  /** A tier-3 transcript peek round happened. */
  peeked: boolean;
  /** What was said out loud (or would have been, on a dry run). */
  spoken: string;
  /** Present when this decision undid an earlier dispatch; mirrors the log entry. */
  correction?: { of_session_id: string | null; of_ts?: string; outcome: RepairOutcome };
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
  const { context: baseContext, sessions, decisions } = await gatherContext(deps, now());
  const attempt = await decide(utterance, baseContext, sessions, deps, now());
  const context = attempt.context;

  let decision = attempt.decision;
  let fallback = attempt.fallbackReason !== undefined;
  let fallbackReason = attempt.fallbackReason;
  let executed = false;
  let targetSessionId: string | null = null;
  let pendingId: string | null = null;
  let repair: RepairResult | null = null;

  if (!fallback && deps.dryRun !== true) {
    try {
      // The repair runs first and on its own: undoing the mistake must not depend on the
      // re-route succeeding, and the person asked for the undo either way. Which dispatch
      // is undone is the decision's to say — the exchange id resolves to a log entry, and
      // an id that resolves to nothing was already rejected by the executability check.
      const corrects = correctionTarget(decision);
      if (corrects !== null) {
        repair = await repairPrevious(resolveExchange(context, decisions, corrects), decisions, {
          client: deps.client,
          windowMs: deps.config.correction_window_min * 60_000,
          now,
          disregardText: disregardTextFor,
        });
      }
      const outcome = await executeDecision(decision, {
        client: deps.client,
        conventionText: deps.conventionText,
        permissionMode: PERMISSION_MODE,
        sessionModel: deps.config.session_model,
        sessionEffort: deps.config.session_effort,
      });
      executed = outcome.executed;
      targetSessionId = outcome.targetSessionId;
      pendingId = outcome.pendingId;
    } catch (error) {
      // The decision was sound; delivering it was not. Same fallback, honest reason.
      decision = fallbackDecision(deps.config);
      fallback = true;
      fallbackReason = `dispatch failed: ${describe(error)}`;
    }
  }

  const spoken = spokenWithRepair(spokenTextOf(decision), repair, deps.config);
  const reach = describeReachback(decision, targetSessionId, attempt, deps);

  const entry: DecisionLogEntry = {
    ts: now().toISOString(),
    utterance,
    context_digest: context.digest,
    decision,
    latency_ms: attempt.latencyMs,
    model: deps.config.router_model,
    target_session_id: targetSessionId,
    executed,
    pending_id: pendingId,
    ...(executed ? { target_status_at_dispatch: targetStatusAtDispatch(decision, context) } : {}),
    ...(repair === null
      ? {}
      : {
          correction: {
            of_session_id: repair.sessionId,
            ...(repair.ofTs === undefined ? {} : { of_ts: repair.ofTs }),
            outcome: repair.outcome,
          },
        }),
    reachback: reach.reachback,
    ...(reach.reason === undefined ? {} : { reachback_reason: reach.reason }),
    peeked: attempt.peeked,
    fallback,
    ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
  };
  appendDecisionEntry(deps.paths.decisionLog, entry);

  // The ack plays after the entry is on disk: a long playback queue may hold the lock for
  // minutes, and the next routing reads its context from the log, not from this process.
  if (deps.dryRun !== true) {
    try {
      await deps.speak(spoken);
    } catch (error) {
      // The dispatch and the log entry are already safe; the ack alone is expendable.
      (deps.warn ?? console.error)(`bob route: could not speak the ack: ${describe(error)}`);
    }
  }

  return {
    decision,
    executed,
    target_session_id: targetSessionId,
    fallback,
    ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
    reachback: reach.reachback,
    ...(reach.reason === undefined ? {} : { reachback_reason: reach.reason }),
    peeked: attempt.peeked,
    spoken,
    ...(repair === null
      ? {}
      : {
          correction: {
            of_session_id: repair.sessionId,
            ...(repair.ofTs === undefined ? {} : { of_ts: repair.ofTs }),
            outcome: repair.outcome,
          },
        }),
    latency_ms: attempt.latencyMs,
    context_digest: context.digest,
  };
}

async function gatherContext(
  deps: RouteDeps,
  now: Date,
): Promise<{ context: RoutingContext; sessions: PoolSession[]; decisions: DecisionLogEntry[] }> {
  let sessions: PoolSession[];
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
  const decisions = readDecisionEntries(deps.paths.decisionLog, { limit: DECISION_HISTORY_LIMIT });
  const dispatches = dispatchEvents(decisions);

  // The unfiltered list is kept: a ledger reach-back needs to address sessions the
  // candidate window has deliberately hidden.
  return {
    sessions,
    decisions,
    context: buildContext({
      sessions,
      spoken,
      dispatches,
      decisions,
      projectsRoot: deps.projectsRoot,
      sessionModels: deps.config.session_models,
      sessionModel: deps.config.session_model,
      projectDirs: deps.projectDirs,
      homeDir: deps.config.home_dir,
      followupWindowMin: deps.config.followup_window_min,
      candidateWindowDays: deps.config.candidate_window_days,
      now,
    }),
  };
}

interface Attempt {
  decision: RouterDecision;
  /** Cumulative across every round the decision took. */
  latencyMs: number;
  /** The context that produced the decision — augmented if a round added to it. */
  context: RoutingContext;
  peeked: boolean;
  /** The ledger query, when a reach-back round happened. */
  lookupQuery?: string;
  /** Set when the deterministic fallback replaced the model's answer. */
  fallbackReason?: string;
}

/**
 * Ask, and be willing to be asked back — at most twice.
 *
 * The model may request a transcript peek (by naming candidates) or a ledger reach-back
 * (by answering `lookup_ledger`). Each is granted once per invocation: enough to resolve
 * a genuine ambiguity, not enough to loop. A second request of the same kind is not an
 * error to argue with, it is a signal the router is not going to settle — so it becomes
 * the deterministic fallback, and the person gets a question instead of a wrong guess.
 */
async function decide(
  utterance: string,
  baseContext: RoutingContext,
  sessions: PoolSession[],
  deps: RouteDeps,
  now: Date,
): Promise<Attempt> {
  let context = baseContext;
  let peeked = false;
  let lookupQuery: string | undefined;
  let latencyMs = 0;

  const fallbackWith = (reason: string): Attempt => ({
    decision: fallbackDecision(deps.config),
    latencyMs,
    context,
    peeked,
    ...(lookupQuery === undefined ? {} : { lookupQuery }),
    fallbackReason: reason,
  });

  for (let round = 0; round < MAX_MODEL_ROUNDS; round += 1) {
    let response;
    try {
      response = await deps.modelCall({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(context, utterance, now),
        model: deps.config.router_model,
        timeoutMs: MODEL_TIMEOUT_MS,
      });
    } catch (error) {
      return fallbackWith(`model call failed: ${describe(error)}`);
    }
    latencyMs += response.latencyMs;

    const raw = extractJson(response.raw);
    if (raw === null) return fallbackWith("model returned no JSON object");

    const parsed = parseRouterDecision(raw);
    if (!parsed.ok) return fallbackWith(`decision failed the schema (${parsed.reason})`);
    const decision = normalizeDecision(parsed.decision);

    if (decision.action === "lookup_ledger") {
      if (lookupQuery !== undefined) {
        return fallbackWith("a second ledger lookup in one invocation");
      }
      lookupQuery = decision.query;
      context = withLedgerMatches(context, decision.query, sessions, deps, now);
      continue;
    }

    const candidates = candidatesOf(decision);
    if (!peeked && candidates.length >= PEEK_CANDIDATE_LIMIT) {
      peeked = true;
      const shortlist = candidates.map((candidate) => candidate.session_id);
      context = { ...context, peeks: await fetchPeekExtracts(deps.client, shortlist) };
      continue;
    }

    const executable = checkExecutable(decision, {
      candidateIds: addressableIds(context),
      placement: { projectsRoot: deps.projectsRoot, homeDir: deps.config.home_dir },
      allowedModels: new Set(deps.config.session_models),
      correctableIds: correctableExchangeIds(context),
    });
    if (!executable.ok) return fallbackWith(`decision is not executable: ${executable.reason}`);

    return {
      decision,
      latencyMs,
      context,
      peeked,
      ...(lookupQuery === undefined ? {} : { lookupQuery }),
    };
  }

  return fallbackWith("the router kept asking for more context instead of deciding");
}

function withLedgerMatches(
  context: RoutingContext,
  query: string,
  sessions: PoolSession[],
  deps: RouteDeps,
  now: Date,
): RoutingContext {
  const matches = buildLedgerMatches({
    hits: grepSpokenLedger(deps.config.home_dir, query),
    sessions,
    alreadyOffered: addressableIds(context),
    now,
  });
  return { ...context, ledger_matches: [...context.ledger_matches, ...matches] };
}

/**
 * A reach-back is a `continue` to a session the candidate window had hidden. Tagging it is
 * what makes the pattern visible later: a run of reach-backs to the same transcript says
 * value is stranded there that should have been produced into files (D9).
 */
function describeReachback(
  decision: RouterDecision,
  targetSessionId: string | null,
  attempt: Attempt,
  deps: RouteDeps,
): { reachback: boolean; reason?: string } {
  if (decision.action !== "continue" || targetSessionId === null) return { reachback: false };

  const windowMinutes = deps.config.candidate_window_days * 24 * 60;
  const fromLedger = attempt.context.ledger_matches.find((match) => match.id === targetSessionId);
  const stale = attempt.context.candidates.find(
    (candidate) => candidate.id === targetSessionId && candidate.minutes_since_active > windowMinutes,
  );
  if (fromLedger === undefined && stale === undefined) return { reachback: false };

  const modelReason = decision.candidates?.find(
    (candidate) => candidate.session_id === targetSessionId,
  )?.reason;
  const reason =
    modelReason ??
    (attempt.lookupQuery === undefined
      ? undefined
      : `surfaced by ledger lookup "${attempt.lookupQuery}"`);
  return { reachback: true, ...(reason === undefined ? {} : { reason }) };
}

function fallbackDecision(config: BobConfig): RouterDecision {
  return { action: "clarify", question: config.clarify_fallback_text };
}

/**
 * The target's status the moment we dispatched — read off the context the decision was made
 * from, because it cannot be reconstructed later. This is what decides, at correction time,
 * whether the turn then running belongs to this dispatch (see repair.ts).
 */
function targetStatusAtDispatch(decision: RouterDecision, context: RoutingContext): string {
  if (decision.action === "new") return "new";
  if (decision.action !== "continue") return "unknown";
  const candidate =
    context.candidates.find((session) => session.id === decision.session_id) ??
    context.ledger_matches.find((session) => session.id === decision.session_id);
  return candidate?.status ?? "unknown";
}

/** The exchanges a correction may name: the ones that actually dispatched somewhere. */
function correctableExchangeIds(context: RoutingContext): Set<string> {
  return new Set(
    context.recent_exchanges
      .filter((exchange) => exchange.target_session_id !== null)
      .map((exchange) => exchange.id),
  );
}

/**
 * An exchange id back to the decision-log entry it stands for. The id is per-invocation;
 * the ts underneath it is the durable identity, so the lookup goes id → ts → entry.
 */
function resolveExchange(
  context: RoutingContext,
  decisions: DecisionLogEntry[],
  exchangeId: string,
): DecisionLogEntry | null {
  const exchange = context.recent_exchanges.find((candidate) => candidate.id === exchangeId);
  if (exchange === undefined) return null;
  return decisions.find((entry) => entry.ts === exchange.ts) ?? null;
}

/**
 * The router writes its ack before the repair has run, so it cannot know whether the undo
 * worked — which is why the recipe forbids it from claiming one. The outcome is appended
 * here, where it is known. An ack that says "undone" over a message still sitting in a
 * queue is worse than the misroute it is reporting on.
 */
function spokenWithRepair(ack: string, repair: RepairResult | null, config: BobConfig): string {
  if (repair === null) return ack;
  if (WITHDRAWN.includes(repair.outcome)) return `${ack} ${config.correction_undone_text}`;
  if (repair.outcome === "left-asleep") return `${ack} ${config.correction_asleep_text}`;
  if (UNWITHDRAWN.includes(repair.outcome)) return `${ack} ${config.correction_blocked_text}`;
  // nothing-to-undo: there was no previous dispatch. Saying so would be noise.
  return ack;
}

function spokenTextOf(decision: RouterDecision): string {
  switch (decision.action) {
    case "continue":
    case "new":
      return decision.ack;
    case "clarify":
      return decision.question;
    case "undo":
      return decision.ack;
    case "lookup_ledger":
      // Unreachable: a lookup is either granted (and re-asked) or turned into the fallback.
      return decision.query;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
