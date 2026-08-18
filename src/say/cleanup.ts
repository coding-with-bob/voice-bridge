/**
 * One signal handler, several duties.
 *
 * A `bobsay` killed mid-sentence has more than one thing to give back: the playback
 * ticket (so the queue does not wait out the 60-second stale net) and, from the barge-in
 * build on, the player child it spawned (so the audio actually stops). Both must happen
 * on the way out, and they cannot be two independent handlers: whichever called
 * `process.exit` first would cut the other off.
 */
type CleanupTask = () => void;

/**
 * How this process should report a signalled death, decided at the moment it dies.
 *
 * A `bobsay` killed by `bob hush` is not a failed command — it is a person deciding they
 * had heard enough — but nothing in an exit code says so, and a session reading a nonzero
 * status does the sensible thing with a failed command: it retries. Observed 2026-08-18:
 * a cut answer was re-spoken five seconds later, in full, before the person's follow-up
 * had even arrived.
 */
export type SignalExit = { code: number; message?: string };
type ExitDecider = () => SignalExit | null;

const tasks = new Set<CleanupTask>();
let decider: ExitDecider | null = null;
let installed = false;

/**
 * Register how to exit when a signal arrives — return null to keep the default. Pass null
 * to clear it once the interesting window (playback) is over.
 */
export function setSignalExit(decide: ExitDecider | null): void {
  decider = decide;
}

function exitAfterCleanup(defaultCode: number): never {
  runAll();
  let decision: SignalExit | null = null;
  try {
    decision = decider?.() ?? null;
  } catch {
    // A decider that throws must not turn a clean exit into a crash.
  }
  if (decision?.message !== undefined) console.error(decision.message);
  process.exit(decision?.code ?? defaultCode);
}

/**
 * Register work to do when this process is signalled or exits. Returns the
 * unregistration function — call it once the work is no longer needed (the ticket was
 * released, the child exited), so the set does not grow with every sentence.
 */
export function registerCleanup(task: CleanupTask): () => void {
  tasks.add(task);
  install();
  return () => {
    tasks.delete(task);
  };
}

function runAll(): void {
  for (const task of [...tasks]) {
    tasks.delete(task);
    try {
      task();
    } catch {
      // One duty failing must not cost the others theirs.
    }
  }
}

function install(): void {
  if (installed) return;
  installed = true;

  process.on("exit", runAll);
  // Replacing the default handler means the exit is now ours to perform.
  process.on("SIGINT", () => exitAfterCleanup(130));
  process.on("SIGTERM", () => exitAfterCleanup(143));
}
