/**
 * Test worker: starts a real `speak()` whose playback never ends, so the parent test can
 * signal this process the way `bob hush` does and inspect how it reports its death. No
 * audio is involved — the engine is a stub that simply waits.
 *
 * Usage: bun test/fixtures/speak-holder.ts <homeDir>
 */
import { speak } from "../../src/say/speak.ts";
import type { PreparedSpeech, SpeechEngine } from "../../src/say/engines/engine.ts";

const homeDir = process.argv[2];
if (!homeDir) {
  console.error("usage: speak-holder.ts <homeDir>");
  process.exit(2);
}

const stalling: SpeechEngine = {
  name: "say",
  available: () => true,
  async prepare(): Promise<PreparedSpeech> {
    return {
      async play() {
        console.log("playing");
        await new Promise(() => {}); // never resolves; the signal is what ends this
      },
      dispose() {},
    };
  },
};

await speak({
  text: "First sentence. Second sentence. Third sentence.",
  sessionId: "s-fixture",
  answerId: "a-fixture",
  homeDir,
  defaultVoice: "say:Tünde",
  engines: { say: stalling, elevenlabs: stalling },
  lockOptions: { pollMs: 5 },
});
