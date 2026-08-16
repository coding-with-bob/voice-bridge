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
  | "cannot-verify"
  | "already-finished"
  | "nothing-to-undo";

export interface RepairResult {
  outcome: RepairOutcome;
  /** The session the repair acted on, or null when there was nothing to act on. */
  sessionId: string | null;
}

/**
 * Sent to a session that received a misrouted message. English because it is an instruction
 * to an agent, not something the person hears (R-11), and blunt because it has to survive
 * being read in the middle of a turn.
 */
export const DISREGARD_TEXT =
  "The previous message was delivered here by mistake and is not your task. " +
  "Disregard it, undo nothing you have not already done for it, and continue what you were doing.";

/** Outcomes the person is told about, because the mistake is still standing in some form. */
export const UNWITHDRAWN: readonly RepairOutcome[] = [
  "queued-not-withdrawable",
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
  /** Sent to a session that received a misrouted message it may already be acting on. */
  disregardText: string;
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
  // Anything dispatched to it since is work the person put there deliberately. Compared by
  // timestamp rather than object identity, so this holds for a log read back from disk.
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

  // A session that exists only because of the mistake holds nothing worth keeping, and
  // leaving it would put a junk candidate in front of every future routing decision.
  if (isDeletableMistake(previous, history, deps.now(), deps.windowMs)) {
    await deps.client.interrupt(sessionId);
    await deps.client.deleteSession(sessionId);
    return { outcome: "deleted", sessionId };
  }

  const state = await deps.client.sessionState(sessionId);
  const pendingId = previous.pending_id ?? null;
  const busy = state.status === "running" || state.status === "waiting";

  if (pendingId !== null && state.pending_inputs.includes(pendingId)) {
    // Interrupting here would cancel a turn that has nothing to do with the mistake. The
    // note still reaches the session before it starts on ours, which is the whole of what
    // is available.
    await deps.client.postMessage(sessionId, deps.disregardText);
    return { outcome: "queued-not-withdrawable", sessionId };
  }

  /**
   * Interrupting requires *positive* proof that the running turn is ours: a pending id that
   * has since drained. Without an id there is no proof, only an inference — and the two
   * errors are not symmetric. Failing to stop a bad message wastes a turn; cancelling the
   * wrong one destroys work the person is waiting for. `pending_inputs` lives in the
   * server's memory, so a restart empties it and makes "absent" mean nothing at all.
   */
  if (pendingId === null && busy) {
    await deps.client.postMessage(sessionId, deps.disregardText);
    return { outcome: "cannot-verify", sessionId };
  }

  if (busy) {
    await deps.client.interrupt(sessionId);
    await deps.client.postMessage(sessionId, deps.disregardText);
    return { outcome: "interrupted", sessionId };
  }

  // Idle: whatever the message caused has already happened. Interrupting would cut into
  // nothing, or into something the person asked for afterwards.
  await deps.client.postMessage(sessionId, deps.disregardText);
  return { outcome: "already-finished", sessionId };
}
