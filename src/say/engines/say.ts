/**
 * The macOS `say` engine — always present, no key, and therefore the floor everything
 * else falls back to.
 */
import { existsSync } from "node:fs";
import { SYSTEM_VOICE } from "../select.ts";
import type { SpeechEngine } from "./engine.ts";

const SAY_BINARY = "/usr/bin/say";

/** Text is always a separate argv element: no shell, so no quoting hazard. */
export function sayArgs(text: string, voice: string): string[] {
  return voice === SYSTEM_VOICE ? ["say", text] : ["say", "-v", voice, text];
}

export const sayEngine: SpeechEngine = {
  name: "say",
  available: () => existsSync(SAY_BINARY),
  async speak(text: string, voice: string): Promise<void> {
    const process = Bun.spawn(sayArgs(text, voice), { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    if (code !== 0) {
      throw new Error(`say exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
  },
};
