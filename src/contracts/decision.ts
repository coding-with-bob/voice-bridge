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

export const ContinueDecisionSchema = z.object({
  action: z.literal("continue"),
  session_id: z.string().min(1),
  /** The utterance cleaned into a request for the target session. */
  request: z.string().min(1),
  /** One short sentence spoken back immediately, before the work starts. */
  ack: z.string().min(1),
  candidates,
});

export const NewDecisionSchema = z.object({
  action: z.literal("new"),
  /** Placement: an existing directory the new session is born in. */
  cwd: z.string().min(1),
  request: z.string().min(1),
  ack: z.string().min(1),
  candidates,
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
]);
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;
export type ContinueDecision = z.infer<typeof ContinueDecisionSchema>;
export type NewDecision = z.infer<typeof NewDecisionSchema>;
export type ClarifyDecision = z.infer<typeof ClarifyDecisionSchema>;
export type LookupLedgerDecision = z.infer<typeof LookupLedgerDecisionSchema>;

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
  /** `continue` to a session inactive beyond the candidate window. */
  reachback: z.boolean(),
  /** A tier-3 transcript peek round happened. */
  peeked: z.boolean(),
  /** The deterministic fallback fired (schema, timeout, error or executability failure). */
  fallback: z.boolean(),
  /** Why the fallback fired — present only when `fallback` is true. */
  fallback_reason: z.string().optional(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;
