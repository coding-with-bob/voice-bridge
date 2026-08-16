/**
 * C5 — the router decision JSON and its log.
 *
 * The union is discriminated on `action` so that a structurally valid but
 * unexecutable decision is impossible: `continue` cannot exist without a
 * session id, `new` cannot exist without a cwd. Schema validity is necessary
 * but not sufficient — executability (does the session id exist in the pool,
 * is the cwd a real directory?) is checked separately, before side effects.
 *
 * Anything that fails either check becomes the deterministic fallback:
 * `{action: "clarify", question: <config.clarify_fallback_text>}`, logged with
 * `fallback: true`. Never a crash, never a guess.
 */
import { z } from "zod";

/** Tier-3 peek trigger: the model is torn between these sessions. */
export const CandidateSchema = z.object({
  session_id: z.string().min(1),
  reason: z.string(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

const candidates = z.array(CandidateSchema).optional();

/**
 * The exchange id of the dispatch this decision supersedes, when the person said it went to
 * the wrong place. Identification is semantic, not positional: the router is shown the
 * recent exchanges with their ids and names the one the utterance means — "az előző" is the
 * latest listed, "the invoice request" is matched by content. A correction that cannot say
 * *which* exchange it corrects is a clarify, never a guess; the id offered must exist, which
 * the executability check enforces like every other address.
 */
const corrects = z.string().min(1).optional();

export const ContinueDecisionSchema = z.object({
  action: z.literal("continue"),
  session_id: z.string().min(1),
  /** The utterance cleaned into a request for the target session. */
  request: z.string().min(1),
  /** One short sentence spoken back immediately, before the work starts. */
  ack: z.string().min(1),
  corrects,
  candidates,
});

/** The set Claude Code's `--effort` accepts; a value outside it is not a decision. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const NewDecisionSchema = z.object({
  action: z.literal("new"),
  /** Placement: an existing directory the new session is born in. */
  cwd: z.string().min(1),
  request: z.string().min(1),
  ack: z.string().min(1),
  /**
   * The model this session is born on, when the utterance asked for one by name. Optional:
   * absent means the configured default, which is the answer almost every time.
   *
   * It exists on `new` alone, and that is not an omission. Omnigent persists
   * `terminal_launch_args` onto the session and relaunches with them, so a revived session
   * comes back on the model it was born with — there is no continuing a session differently.
   *
   * Like `cwd`, it is offered as a closed vocabulary and checked for membership before the
   * session is created; the schema only says the shape is right.
   */
  model: z.string().min(1).optional(),
  effort: EffortSchema.optional(),
  corrects,
  candidates,
});

/**
 * "No, that was wrong" with nowhere named to put it instead. The repair runs and nothing is
 * dispatched — distinct from `clarify`, which asks a question and leaves the mistake standing.
 * Even an undo has to say which exchange it undoes; an unidentifiable one is a clarify.
 */
export const UndoDecisionSchema = z.object({
  action: z.literal("undo"),
  corrects: z.string().min(1),
  ack: z.string().min(1),
});

export const ClarifyDecisionSchema = z.object({
  action: z.literal("clarify"),
  /** Spoken back; the pool is left untouched. */
  question: z.string().min(1),
  candidates,
});

/**
 * The contractual reach-back trigger. The router greps the full spoken ledger
 * for `query`, adds the matching sessions to the context and re-asks once;
 * a second lookup in the same invocation becomes the deterministic fallback.
 */
export const LookupLedgerDecisionSchema = z.object({
  action: z.literal("lookup_ledger"),
  query: z.string().min(1),
  candidates,
});

export const RouterDecisionSchema = z.discriminatedUnion("action", [
  ContinueDecisionSchema,
  NewDecisionSchema,
  ClarifyDecisionSchema,
  LookupLedgerDecisionSchema,
  UndoDecisionSchema,
]);
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
export type ContinueDecision = z.infer<typeof ContinueDecisionSchema>;
export type NewDecision = z.infer<typeof NewDecisionSchema>;
export type ClarifyDecision = z.infer<typeof ClarifyDecisionSchema>;
export type LookupLedgerDecision = z.infer<typeof LookupLedgerDecisionSchema>;
export type UndoDecision = z.infer<typeof UndoDecisionSchema>;

/**
 * Candidates are a request to look closer before committing to an address. An action that
 * addresses nothing — an undo — has nothing to be torn between, so it carries none.
 */
export function candidatesOf(decision: RouterDecision): Candidate[] {
  return "candidates" in decision ? (decision.candidates ?? []) : [];
}

/** The exchange id this decision undoes before doing anything of its own, if any. */
export function correctionTarget(decision: RouterDecision): string | null {
  if (decision.action === "undo") return decision.corrects;
  if (decision.action === "continue" || decision.action === "new") {
    return decision.corrects ?? null;
  }
  return null;
}

export type DecisionParseResult =
  | { ok: true; decision: RouterDecision }
  | { ok: false; reason: string };

/** Validate model output without throwing — the caller routes failures to the fallback. */
export function parseRouterDecision(raw: unknown): DecisionParseResult {
  const result = RouterDecisionSchema.safeParse(raw);
  if (result.success) return { ok: true, decision: result.data };
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason };
}

/**
 * One line per invocation in `~/bob/logs/route-decisions.jsonl`.
 * The `executed: true` entries double as the dispatch half of C2's recency derivation.
 */
export const DecisionLogEntrySchema = z.object({
  ts: z.iso.datetime(),
  /** The utterance as it arrived, before cleaning. */
  utterance: z.string(),
  /** Human-readable one-liner of the context the model saw — for later forensics. */
  context_digest: z.string(),
  /** The decision that was acted on (post-fallback), or null if nothing parseable came back. */
  decision: RouterDecisionSchema.nullable(),
  latency_ms: z.number().nonnegative(),
  model: z.string(),
  /**
   * The session the utterance was actually delivered to: the existing one for `continue`,
   * the freshly created one for `new`, null when nothing was dispatched. C2 derives "most
   * recent interaction" from these entries, and for a `new` decision the target only exists
   * after createSession returns — so it has to be recorded here rather than read off `decision`.
   */
  target_session_id: z.string().nullable(),
  /** Whether the action was actually carried out (a dispatch happened). */
  executed: z.boolean(),
  /**
   * The `pending_id` the server minted for this dispatch, when it gave one. A correction
   * reads it back to ask the only question that decides whether interrupting is safe: has
   * this message started, or is it still queued behind work that has nothing to do with it?
   */
  pending_id: z.string().nullable().optional(),
  /** This decision undid the previous dispatch first; the repair's outcome is recorded with it. */
  correction: z
    .object({
      /** The dispatch that was undone. */
      of_session_id: z.string().nullable(),
      /** Its decision-log timestamp — the durable identity behind the per-invocation exchange id. */
      of_ts: z.string().optional(),
      /** What the repair could actually do — the C5 record of a misroute. */
      outcome: z.enum([
        "deleted",
        "interrupted",
        "queued-not-withdrawable",
        "cannot-verify",
        "already-finished",
        "nothing-to-undo",
      ]),
    })
    .optional(),
  /** `continue` to a session inactive beyond the candidate window. */
  reachback: z.boolean(),
  /** Why that session: the model's own reason, or the ledger query that surfaced it. */
  reachback_reason: z.string().optional(),
  /** A tier-3 transcript peek round happened. */
  peeked: z.boolean(),
  /** The deterministic fallback fired (schema, timeout, error or executability failure). */
  fallback: z.boolean(),
  /** Why the fallback fired — present only when `fallback` is true. */
  fallback_reason: z.string().optional(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;
