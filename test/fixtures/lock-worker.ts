/**
 * Test worker: takes the playback lock in a separate process, records when it entered and
 * left the critical section, then releases. Used to prove serialisation across processes,
 * which is the case that actually matters — two sessions calling `bobsay` at once.
 *
 * Usage: bun test/fixtures/lock-worker.ts <lockDir> <recordFile> <label> <holdMs>
 */
import { appendFileSync } from "node:fs";
import { acquireLock } from "../../src/say/lock.ts";

const [lockDir, recordFile, label, holdMs] = process.argv.slice(2);
if (!lockDir || !recordFile || !label || !holdMs) {
  console.error("usage: lock-worker.ts <lockDir> <recordFile> <label> <holdMs>");
  process.exit(2);
}

const handle = await acquireLock(lockDir, { pollMs: 5 });
appendFileSync(recordFile, `in ${label}\n`);
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
appendFileSync(recordFile, `out ${label}\n`);
handle.release();
