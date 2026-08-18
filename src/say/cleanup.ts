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

const tasks = new Set<CleanupTask>();
let installed = false;

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
  process.on("SIGINT", () => {
    runAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    runAll();
    process.exit(143);
  });
}
