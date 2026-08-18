/**
 * A FIFO file lock, so two sessions never talk over each other.
 *
 * Each caller drops a ticket into the lock directory named by arrival time; the
 * lexicographically smallest ticket holds the lock. Arrival order is preserved, which
 * plain exclusive-create locking does not give you — the sentence you triggered first
 * is the sentence you hear first.
 *
 * Crash safety: a ticket whose owner died stops being refreshed and is pruned as stale,
 * so a killed `bobsay` cannot wedge the queue. Live holders and live waiters both
 * heartbeat their own ticket, so "stale" only ever means "nobody is behind this".
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseTicketBody, type TicketBody } from "../contracts/playback.ts";

export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
}

export interface LockHandle {
  release(): void;
  /**
   * Rewrite this ticket's C7 body in place — the holder calls it at every sentence
   * boundary so `remaining_text` always names the unspoken tail. No-op after release.
   */
  rewriteBody(body: TicketBody): void;
}

export interface LockOptions {
  /** How long a ticket may go unrefreshed before it is considered abandoned. */
  staleMs?: number;
  /** How often the queue is re-examined. */
  pollMs?: number;
  /** How long to wait for the lock before giving up. */
  timeoutMs?: number;
  /** C7 metadata written into the ticket file, so `bob hush` can see who speaks what. */
  body?: TicketBody;
}

/**
 * The wait deadline is a last-resort ceiling, not a schedule. A dead holder is pruned by
 * the stale net within `staleMs`, so this deadline only ever fires against a holder that
 * is alive and heartbeating — which is either legitimate long playback (a spoken answer
 * runs minutes; several may queue) or a genuinely wedged process. It must therefore
 * outlive any queue of real speech; the invariant test ties it to MAX_SPOKEN_CHARS.
 * On breach the caller speaks anyway and says so — overlap, never a lost sentence.
 */
export const DEFAULT_WAIT_CEILING_MS = 1_800_000;

const DEFAULTS = { staleMs: 60_000, pollMs: 25, timeoutMs: DEFAULT_WAIT_CEILING_MS } as const;
const TICKET_SUFFIX = ".ticket";

/**
 * The holder marker: whoever creates it exclusively IS the holder, and it names the
 * holding ticket. Name order alone cannot carry mutual exclusion — two tickets minted in
 * the same millisecond sort by pid, and the pid order is not the arrival order, so a
 * later write could sort ahead of a ticket already inside the critical section (observed
 * 2026-08-18 as overlapping playback in the cross-process test). The FIFO decides who may
 * *try*; the atomic `wx` create decides who *holds*.
 */
const HOLDER_MARKER = "holder.lock";

/** Distinguishes tickets taken within the same millisecond by the same process. */
let sequence = 0;

/**
 * Tickets this process is holding right now.
 *
 * Stale pruning is the safety net for a process that dies without warning, but it is a
 * 60-second net: interrupt a `bobsay` mid-sentence and the next one waits out the whole
 * minute in silence, with nothing to explain itself. A signal we can catch is not an
 * unwarned death, so we give the ticket back on the way out.
 */
const heldTickets = new Set<string>();
let cleanupInstalled = false;

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;

  const releaseAll = (): void => {
    for (const path of heldTickets) {
      releaseMarker(dirname(path), basename(path));
      remove(path);
    }
    heldTickets.clear();
  };

  process.on("exit", releaseAll);
  // Replacing the default handler means the exit is now ours to perform.
  process.on("SIGINT", () => {
    releaseAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseAll();
    process.exit(143);
  });
}

export async function acquireLock(lockDir: string, options: LockOptions = {}): Promise<LockHandle> {
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  mkdirSync(lockDir, { recursive: true });
  const ticket = mintTicketName();
  const ticketPath = join(lockDir, ticket);
  writeFileSync(ticketPath, options.body ? JSON.stringify(options.body) : "");

  const deadline = Date.now() + timeoutMs;
  try {
    while (!(isSmallestLive(lockDir, ticket, staleMs) && claimHolder(lockDir, ticket))) {
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `Timed out after ${timeoutMs}ms waiting for the playback lock in ${lockDir}.`,
        );
      }
      touch(ticketPath); // a waiting ticket is a live ticket
      await sleep(pollMs);
    }
  } catch (error) {
    remove(ticketPath);
    throw error;
  }

  return startHolding(ticketPath, staleMs);
}

export interface TicketView {
  /** The ticket's filename — also its FIFO rank. */
  name: string;
  /** The owning process, parsed from the filename. */
  pid: number;
  /** The C7 body, or null when the body is unreadable (old format, partial write). */
  body: TicketBody | null;
}

/**
 * A read-only view of the queue, in FIFO order, for `bob hush` and friends.
 * Does no pruning and takes no side effects — observation must not race the queue.
 */
export function readTickets(lockDir: string): TicketView[] {
  let names: string[];
  try {
    names = readdirSync(lockDir).filter((name) => name.endsWith(TICKET_SUFFIX));
  } catch {
    return []; // no directory yet means nobody has ever queued
  }
  const tickets: TicketView[] = [];
  for (const name of names.sort()) {
    const pid = pidFromTicketName(name);
    if (pid === null) continue;
    let raw: string;
    try {
      raw = readFileSync(join(lockDir, name), "utf8");
    } catch {
      continue; // released between readdir and read; the queue moved on
    }
    tickets.push({ name, pid, body: parseTicketBody(raw) });
  }
  return tickets;
}

function pidFromTicketName(name: string): number | null {
  const match = /^\d+-(\d+)-\d+\.ticket$/.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function mintTicketName(): string {
  const stamp = String(Date.now()).padStart(15, "0");
  const pid = String(process.pid).padStart(7, "0");
  const seq = String(sequence++).padStart(6, "0");
  return `${stamp}-${pid}-${seq}${TICKET_SUFFIX}`;
}

/**
 * Try to become the holder by creating the marker exclusively. On failure, check whether
 * the standing marker outlived its ticket (a crashed holder whose stale ticket was
 * pruned) and reap it, so the queue recovers on the next poll.
 */
function claimHolder(lockDir: string, ticket: string): boolean {
  const markerPath = join(lockDir, HOLDER_MARKER);
  try {
    writeFileSync(markerPath, ticket, { flag: "wx" });
    return true;
  } catch {
    reapDeadHolder(lockDir, markerPath);
    return false;
  }
}

function reapDeadHolder(lockDir: string, markerPath: string): void {
  let holderTicket: string;
  try {
    holderTicket = readFileSync(markerPath, "utf8");
  } catch {
    return; // marker vanished between claim and read — somebody else settled it
  }
  if (holderTicket !== "" && existsSync(join(lockDir, holderTicket))) return; // genuinely held
  remove(markerPath);
}

/** A holder gives its marker back on the way out — but only its own. */
function releaseMarker(lockDir: string, ticket: string): void {
  const markerPath = join(lockDir, HOLDER_MARKER);
  try {
    if (readFileSync(markerPath, "utf8") === ticket) unlinkSync(markerPath);
  } catch {
    // Already gone.
  }
}

function isSmallestLive(lockDir: string, ticket: string, staleMs: number): boolean {
  const cutoff = Date.now() - staleMs;
  const live: string[] = [];
  for (const name of readdirSync(lockDir)) {
    if (!name.endsWith(TICKET_SUFFIX)) continue;
    if (name !== ticket && isAbandoned(join(lockDir, name), cutoff)) {
      remove(join(lockDir, name));
      continue;
    }
    live.push(name);
  }
  return live.sort()[0] === ticket;
}

function isAbandoned(path: string, cutoff: number): boolean {
  try {
    return statSync(path).mtimeMs < cutoff;
  } catch {
    return false; // already gone; nothing to prune
  }
}

function startHolding(ticketPath: string, staleMs: number): LockHandle {
  const heartbeat = setInterval(() => touch(ticketPath), Math.max(10, Math.floor(staleMs / 3)));
  heartbeat.unref?.();
  heldTickets.add(ticketPath);
  installCleanup();

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      heldTickets.delete(ticketPath);
      releaseMarker(dirname(ticketPath), basename(ticketPath));
      remove(ticketPath);
    },
    rewriteBody(body: TicketBody) {
      if (released) return;
      writeFileSync(ticketPath, JSON.stringify(body));
    },
  };
}

function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // The ticket was pruned or the directory vanished; the next poll settles it.
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
