/**
 * Test worker: plays a long-running fake "player" through runPlayer, so the parent test
 * can signal this process and check that the child died with it — the C1 obligation that
 * makes `bob hush` = "SIGTERM the holder pid" enough to actually stop the audio.
 *
 * Usage: bun test/fixtures/player-holder.ts <pidFile>
 */
import { runPlayer } from "../../src/say/player.ts";

const pidFile = process.argv[2];
if (!pidFile) {
  console.error("usage: player-holder.ts <pidFile>");
  process.exit(2);
}

// The child writes its own pid, so the test kills the parent and inspects the child.
await runPlayer(["/bin/sh", "-c", `echo $$ > ${pidFile}; sleep 30`]);
