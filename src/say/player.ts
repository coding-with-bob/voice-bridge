/**
 * Spawning the process that actually makes the sound — `afplay` for ElevenLabs, `say`
 * for the macOS voice — with the C1 obligation attached: a `bobsay` that is signalled
 * silences its player before it goes. Without it, killing the holder would return the
 * ticket and leave the audio talking to an empty room, and `bob hush` would not hush.
 */
import { basename } from "node:path";
import { registerCleanup } from "./cleanup.ts";

export async function runPlayer(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const unregister = registerCleanup(() => {
    // SIGKILL, not SIGTERM: a player has nothing to finalise, and the point of the
    // barge-in is that the room goes quiet now.
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });

  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) {
      const complaint = stderr.trim();
      throw new Error(
        `${basename(command[0] ?? "player")} exited ${code}${complaint ? `: ${complaint}` : ""}`,
      );
    }
  } finally {
    unregister();
  }
}
