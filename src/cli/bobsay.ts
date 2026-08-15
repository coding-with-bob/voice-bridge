#!/usr/bin/env bun
/**
 * `bobsay` — the TTS CLI sessions call to speak a result (C1).
 *
 * Exit 0 means the sentence was heard. Exit 1 means it could not be spoken at all, even
 * after the fallback. Exit 2 means the call itself was wrong (bad voice, bad config,
 * nothing speakable) and was rejected before any audio.
 */
import { Command } from "commander";
import { version } from "../version.ts";
import { loadConfig, ConfigError } from "../config/load.ts";
import { speak, CouldNotSpeakError, NothingToSpeakError } from "../say/speak.ts";
import { VoiceSelectionError } from "../say/select.ts";
import { sayEngine } from "../say/engines/say.ts";
import { elevenLabsEngine } from "../say/engines/elevenlabs.ts";

const EXIT_COULD_NOT_SPEAK = 1;
const EXIT_BAD_CALL = 2;

const program = new Command();

program
  .name("bobsay")
  .description("Speak one sentence out loud and record it in the spoken log")
  .version(version)
  .argument("<text>", "the sentence to speak — plain, no markdown")
  .option("--session <id>", "the session speaking; omit for sessionless calls such as router acks")
  .option("--voice <engine:voice>", "override the configured default voice")
  .option("--engine <engine>", "force an engine: elevenlabs | say")
  .option("--json", "emit {spoken_text, engine, voice, log_path}")
  .action(async (text: string, options: Record<string, string | boolean | undefined>) => {
    try {
      const { config } = loadConfig();
      const result = await speak({
        text,
        sessionId: (options.session as string | undefined) ?? null,
        homeDir: config.home_dir,
        defaultVoice: config.default_voice,
        voice: options.voice as string | undefined,
        engine: options.engine as string | undefined,
        engines: { say: sayEngine, elevenlabs: elevenLabsEngine },
      });
      if (options.json) console.log(JSON.stringify(result));
    } catch (error) {
      console.error(`bobsay: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(exitCodeFor(error));
    }
  });

await program.parseAsync();

function exitCodeFor(error: unknown): number {
  const rejectedBeforeAudio =
    error instanceof ConfigError ||
    error instanceof VoiceSelectionError ||
    error instanceof NothingToSpeakError;
  if (rejectedBeforeAudio) return EXIT_BAD_CALL;
  if (error instanceof CouldNotSpeakError) return EXIT_COULD_NOT_SPEAK;
  return EXIT_COULD_NOT_SPEAK;
}
