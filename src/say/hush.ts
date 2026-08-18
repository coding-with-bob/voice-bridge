/**
 * `bob hush` — stop talking and listen.
 *
 * Pressing the PTT chord while something plays means exactly that, so this runs before
 * the recorder starts. Three things happen, in this order:
 *
 *   1. the playing answer dies — the holder, and any queued chunk of the *same* answer;
 *   2. what was cut is written down, from the unheard side only (C7b);
 *   3. the queue is paused, so nothing else starts talking while the person speaks (C7c).
 *
 * The boundary that makes this safe: **hush touches audio, never the session.** No post,
 * no stop, no interrupt reaches Omnigent. Killing playback is honest precisely because
 * the C2 ledger is written after playback, so the unplayed part was never a fact.
 */
import { forceRelease, readHolderTicket, readTickets, type TicketView } from "./lock.ts";
import { appendInterruption } from "./interruptions.ts";
import { writePauseMarker } from "./pause.ts";
import { playbackLockDir, PAUSE_DEADLINE_MS } from "../contracts/playback.ts";

export interface HushOptions {
  homeDir: string;
  now?: () => Date;
  /** Injected for tests; defaults to the real signal. */
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  alive?: (pid: number) => boolean;
  /** How long a holder may take to honour SIGTERM before SIGKILL. */
  graceMs?: number;
  pollMs?: number;
  deadlineMs?: number;
}

export interface HushResult {
  killed: boolean;
  session_id: string | null;
  answer_id: string | null;
  /** The holder's unspoken tail, starting at the sentence that was cut. */
  interrupted_text: string | null;
  /** Same-answer chunks that were removed before they ever played. */
  unplayed_texts: string[];
  /** Whether a C7 interruption record was appended (a sessionless kill records nothing). */
  recorded: boolean;
  /** When the quiet window expires if nothing lifts it first. */
  paused_until: string;
}

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_POLL_MS = 25;

export async function hush(options: HushOptions): Promise<HushResult> {
  const now = options.now ?? (() => new Date());
  const kill = options.kill ?? defaultKill;
  const alive = options.alive ?? defaultAlive;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const lockDir = playbackLockDir(options.homeDir);
  const tickets = readTickets(lockDir);
  const holderName = readHolderTicket(lockDir);
  const holder = tickets.find((ticket) => ticket.name === holderName) ?? null;

  const pause = () =>
    writePauseMarker(options.homeDir, now(), options.deadlineMs ?? PAUSE_DEADLINE_MS);

  if (holder === null) {
    // Nothing is playing, but the pause still goes down: the person is about to speak,
    // and a queued answer must not start talking over them mid-utterance.
    return {
      killed: false,
      session_id: null,
      answer_id: null,
      interrupted_text: null,
      unplayed_texts: [],
      recorded: false,
      paused_until: pause().deadline,
    };
  }

  await killHolder(lockDir, holder, { kill, alive, graceMs, pollMs });

  const siblings = sameAnswerSiblings(tickets, holder);
  for (const sibling of siblings) {
    // Signal first, then take the ticket out: a *waiting* bobsay has no cleanup
    // registered yet, so nobody else would ever remove it and the queue would wait out
    // the whole stale net in silence.
    kill(sibling.pid, "SIGTERM");
    forceRelease(lockDir, sibling.name);
  }

  const unplayedTexts = siblings.map((sibling) => sibling.body?.remaining_text ?? "");
  const sessionId = holder.body?.session_id ?? null;
  // A sessionless holder is a router ack, and an interrupted ack is not an event worth
  // routing on. A holder whose body will not parse has nothing to say either.
  const recorded = sessionId !== null;
  if (recorded) {
    appendInterruption(options.homeDir, {
      ts: now().toISOString(),
      session_id: sessionId,
      answer_id: holder.body?.answer_id ?? null,
      interrupted_text: holder.body?.remaining_text ?? "",
      unplayed_texts: unplayedTexts,
    });
  }

  return {
    killed: true,
    session_id: sessionId,
    answer_id: holder.body?.answer_id ?? null,
    interrupted_text: holder.body?.remaining_text ?? null,
    unplayed_texts: unplayedTexts,
    recorded,
    paused_until: pause().deadline,
  };
}

/**
 * SIGTERM, then SIGKILL if it is ignored — the PTT lua's pattern, for the same reason: a
 * process wedged in CoreAudio never runs its graceful handler, and a wedged holder would
 * keep both the audio and the queue. A SIGKILLed holder cannot clean up, so its ticket
 * and the holder marker are reaped here.
 */
async function killHolder(
  lockDir: string,
  holder: TicketView,
  deps: {
    kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
    alive: (pid: number) => boolean;
    graceMs: number;
    pollMs: number;
  },
): Promise<void> {
  deps.kill(holder.pid, "SIGTERM");

  const deadline = Date.now() + deps.graceMs;
  while (deps.alive(holder.pid)) {
    if (Date.now() >= deadline) {
      deps.kill(holder.pid, "SIGKILL");
      forceRelease(lockDir, holder.name);
      return;
    }
    await sleep(deps.pollMs);
  }
}

/**
 * Chunks of the same answer, queued behind the holder. A null answer id matches nothing:
 * a lone-call answer has no siblings, and neither does a ticket with no readable body.
 */
function sameAnswerSiblings(tickets: TicketView[], holder: TicketView): TicketView[] {
  const answerId = holder.body?.answer_id ?? null;
  if (answerId === null) return [];
  return tickets.filter(
    (ticket) =>
      ticket.name !== holder.name &&
      ticket.body !== null &&
      ticket.body.answer_id === answerId &&
      ticket.body.session_id === holder.body?.session_id,
  );
}

function defaultKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone — the queue moved on while we were reading it.
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
