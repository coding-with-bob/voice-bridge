/**
 * The macOS `say` engine — always present, no key, and therefore the floor everything
 * else falls back to.
 */
import { existsSync } from "node:fs";
import { SYSTEM_VOICE } from "../select.ts";
import type { PreparedSpeech, SpeechEngine } from "./engine.ts";

const SAY_BINARY = "/usr/bin/say";

/**
 * Text is always a separate argv element — no shell, so no quoting hazard — and always
 * behind `--`, because a sentence may legitimately begin with a hyphen and `say` would
 * otherwise read "-5 degrees tonight" as a flag and refuse to speak at all.
 */
export function sayArgs(text: string, voice: string): string[] {
  return voice === SYSTEM_VOICE ? ["say", "--", text] : ["say", "-v", voice, "--", text];
}

export const sayEngine: SpeechEngine = {
  name: "say",
  available: () => existsSync(SAY_BINARY),
  // `say` synthesises as it plays, so prepare has no work — the two-phase shape exists
  // for engines that fetch audio; here it just defers the spawn to play time.
  async prepare(text: string, voice: string): Promise<PreparedSpeech> {
    return {
      async play() {
        const process = Bun.spawn(sayArgs(text, voice), { stdout: "ignore", stderr: "pipe" });
        const [code, stderr] = await Promise.all([
          process.exited,
          new Response(process.stderr).text(),
        ]);
        if (code !== 0) {
          throw new Error(`say exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
        }
      },
      dispose() {},
    };
  },
};
