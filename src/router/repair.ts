/**
 * Undoing the previous dispatch, when the person says it went to the wrong place.
 *
 * The whole module exists because the obvious implementation is wrong. "Interrupt whatever
 * the last dispatch reached" destroys work whenever that session was already busy: a message
 * to a running session **queues** rather than interrupts, so cancelling the running turn kills
 * the legitimate work — and since an interrupt clears no queue, the misrouted message starts
 * next. Both halves wrong, from one plausible line of code.
 *
 * So the repair asks a question first: has our own message started? A native-terminal message
 * gets a `pending_id`, and the session snapshot lists it under `pending_inputs` until it is
 * consumed. Present means still queued; absent means it is running or done.
 *
 * Withdrawing a queued message is not possible — there is no dequeue endpoint. That state
 * therefore gets the honest answer rather than a destructive one: leave the process alone,
 * tell the session to disregard the message, and let the ack say it could not be pulled back.
 */
import type { DecisionLogEntry } from "../contracts/decision.ts";
import type { OmnigentClient } from "../omnigent/client.ts";

export type RepairOutcome =
  | "deleted"
  | "interrupted"
  | "queued-not-withdrawable"
  /** Consumed into a turn that was already running at dispatch — never interruptible. */
  | "foreign-turn"
  /** The session sleeps; the mistake has run its course, and a note is not worth waking it for. */
  | "left-asleep"
  | "cannot-verify"
  | "already-finished"
  | "nothing-to-undo";

export interface RepairResult {
  outcome: RepairOutcome;
  /** The session the repair acted on, or null when there was nothing to act on. */
  sessionId: string | null;
  /** The decision-log ts of the corrected dispatch, when one was identified. */
  ofTs?: string;
}

/**
 * Sent to a session that received a misrouted message. English because it is an instruction
 * to an agent, not something the person hears (R-11), and blunt because it has to survive
 * being read in the middle of a turn.
 */
/**
 * "The previous message" would be ambiguous whenever a legitimate dispatch arrived after
 * the mistake — the session would disregard the wrong one. So the note identifies the
 * message the same way the correction identified the exchange: by content.
 */
export function disregardTextFor(request: string): string {
  const quoted = request.replace(/\s+/g, " ").trim().slice(0, 120);
  return (
    `A message delivered to you earlier was misrouted and is not your task — the one asking: ` +
    `"${quoted}". Disregard that message specifically, undo nothing you have not already done ` +
    `for it, and continue what you were doing.`
  );
}

/** Outcomes the person is told about, because the mistake is still standing in some form. */
export const UNWITHDRAWN: readonly RepairOutcome[] = [
  "queued-not-withdrawable",
  "foreign-turn",
  "cannot-verify",
  // Already finished counts as not withdrawn: the note was sent, but the work happened.
  "already-finished",
];

/** The mistake was actually stopped — the only outcomes that may be reported as undone. */
export const WITHDRAWN: readonly RepairOutcome[] = ["deleted", "interrupted"];

export interface RepairDeps {
  client: Pick<OmnigentClient, "interrupt" | "deleteSession" | "postMessage" | "sessionState">;
  /** How recent the mistake must be for its session to be deletable. */
  windowMs: number;
  now: () => Date;
  /** Builds the note for the misrouted request — identified by content, never by position. */
  disregardText: (request: string) => string;
}

/**
 * The deletion invariant, stated as a function rather than trusted to care.
 *
 * A correction may delete **only** a session the immediately preceding decision itself
 * created. Anything else — an older mistake, a session that has since been used, a `continue`
 * target that existed before — is out of reach by construction, so a router that misreads an
 * utterance as a correction still cannot destroy work that was there before it.
 */
export function isDeletableMistake(
  previous: DecisionLogEntry,
  history: DecisionLogEntry[],
  now: Date,
  windowMs: number,
): boolean {
  if (previous.decision?.action !== "new") return false;
  if (previous.target_session_id === null || !previous.executed) return false;
  const at = Date.parse(previous.ts);
  if (now.getTime() - at > windowMs) return false;
  return nothingDispatchedSince(previous, history);
}

/**
 * Anything dispatched to the same session after `previous` is work the person put there
 * deliberately — it forfeits both deletion and the interrupt proof. Compared by timestamp
 * rather than object identity, so this holds for a log read back from disk.
 */
function nothingDispatchedSince(previous: DecisionLogEntry, history: DecisionLogEntry[]): boolean {
  const at = Date.parse(previous.ts);
  return !history.some(
    (entry) =>
      entry.executed &&
      entry.target_session_id === previous.target_session_id &&
      Date.parse(entry.ts) > at,
  );
}

/**
 * `previous` is the most recent executed dispatch; `history` is the log it came from, used
 * only to prove nothing else has touched that session since.
 */
export async function repairPrevious(
  previous: DecisionLogEntry | null,
  history: DecisionLogEntry[],
  deps: RepairDeps,
): Promise<RepairResult> {
  if (previous === null || !previous.executed || previous.target_session_id === null) {
    return { outcome: "nothing-to-undo", sessionId: null };
  }
  const sessionId = previous.target_session_id;
  const ofTs = previous.ts;
  const decision = previous.decision;
  const request =
    decision !== null && (decision.action === "continue" || decision.action === "new")
      ? decision.request
      : previous.utterance;
  const note = deps.disregardText(request);

  // A session that exists only because of the mistake holds nothing worth keeping, and
  // leaving it would put a junk candidate in front of every future routing decision.
  if (isDeletableMistake(previous, history, deps.now(), deps.windowMs)) {
    await deps.client.interrupt(sessionId);
    await deps.client.deleteSession(sessionId);
    return { outcome: "deleted", sessionId, ofTs };
  }

  const state = await deps.client.sessionState(sessionId);
  const pendingId = previous.pending_id ?? null;
  const busy = state.status === "running" || state.status === "waiting";

  if (pendingId !== null && state.pending_inputs.includes(pendingId)) {
    // Interrupting here would cancel a turn that has nothing to do with the mistake. The
    // note still reaches the session before it starts on ours, which is the whole of what
    // is available.
    await deps.client.postMessage(sessionId, note);
    return { outcome: "queued-not-withdrawable", sessionId, ofTs };
  }

  if (busy) {
    /**
     * Interrupting requires *positive* proof that the running turn is ours, and "our
     * pending id has drained" is not it: a queued message drains into a *foreign* turn at
     * its first tool boundary and merges with it (measured 2026-08-17 — drained 3s in,
     * turn still running; the first microphone trial interrupted an essay this way). The
     * proof is the fact recorded at dispatch: a message sent to an idle session started
     * the turn that is running now — unless something else was dispatched there since.
     * The two errors stay asymmetric: failing to stop a bad message wastes a turn;
     * cancelling the wrong one destroys work the person is waiting for.
     */
    const atDispatch = previous.target_status_at_dispatch;
    if (atDispatch === "running" || atDispatch === "waiting") {
      // Ours queued or merged into someone else's turn — never interruptible.
      await deps.client.postMessage(sessionId, note);
      return { outcome: "foreign-turn", sessionId, ofTs };
    }
    if ((atDispatch === "idle" || atDispatch === "new") && nothingDispatchedSince(previous, history)) {
      await deps.client.interrupt(sessionId);
      await deps.client.postMessage(sessionId, note);
      return { outcome: "interrupted", sessionId, ofTs };
    }
    // Status unknown (an older log entry), or something else dispatched since: no proof.
    await deps.client.postMessage(sessionId, note);
    return { outcome: "cannot-verify", sessionId, ofTs };
  }

  // Idle: whatever the message caused has already happened. Interrupting would cut into
  // nothing, or into something the person asked for afterwards.
  if (state.runner_online === false) {
    // Posting the note would revive the session — spawn a process just to deliver "ignore
    // something you are not working on". Sleep is left alone; the log carries the truth.
    return { outcome: "left-asleep", sessionId, ofTs };
  }
  await deps.client.postMessage(sessionId, note);
  return { outcome: "already-finished", sessionId, ofTs };
}
