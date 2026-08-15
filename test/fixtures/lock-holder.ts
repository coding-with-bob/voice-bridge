/**
 * Test worker: takes the lock and holds it until something kills it. Used to prove that an
 * interrupted holder gives its ticket back instead of making the next caller wait out the
 * full stale timeout in silence.
 *
 * Usage: bun test/fixtures/lock-holder.ts <lockDir>
 */
import { acquireLock } from "../../src/say/lock.ts";

const lockDir = process.argv[2];
if (!lockDir) {
  console.error("usage: lock-holder.ts <lockDir>");
  process.exit(2);
}

await acquireLock(lockDir, { pollMs: 5 });
console.log("holding");
await new Promise(() => {});
