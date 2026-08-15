/**
 * The C1 pipeline: clean → select voice → take the playback lock → speak → log.
 *
 * Two invariants drive the shape of this module:
 *   - the ledger records only what was actually heard, so the C2 append happens after
 *     playback resolves and never before;
 *   - the ElevenLabs fallback is audible — when it fails, the sentence is still spoken,
 *     in the macOS voice, and the log names the engine that really spoke.
 */
import { join } from "node:path";
import { cleanForSpeech } from "./clean.ts";
import { applyProsody } from "./prosody.ts";
import { fallbackSayVoice, selectVoice } from "./select.ts";
import { acquireLock, LockTimeoutError, type LockOptions } from "./lock.ts";
import { appendSpokenLine } from "./spoken-log.ts";
import type { EngineRegistry } from "./engines/engine.ts";
import type { Engine } from "../contracts/spoken-log.ts";

export class NothingToSpeakError extends Error {
  override name = "NothingToSpeakError";
}

export class CouldNotSpeakError extends Error {
  override name = "CouldNotSpeakError";
}

export interface SpeakOptions {
  text: string;
  /** The session speaking, or null for sessionless calls such as router acks. */
  sessionId: string | null;
  homeDir: string;
  defaultVoice: string;
  engines: EngineRegistry;
  voice?: string;
  engine?: string;
  lockOptions?: LockOptions;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** Exactly the payload C1 promises for `--json`. */
export interface SpeakResult {
  spoken_text: string;
  engine: Engine;
  voice: string;
  log_path: string;
}

export async function speak(options: SpeakOptions): Promise<SpeakResult> {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.error(message));

  const cleaned = cleanForSpeech(options.text);
  if (cleaned === "") {
    throw new NothingToSpeakError("Nothing speakable left after cleaning — refusing to speak.");
  }
  const spokenText = applyProsody(cleaned, "plain");

  const requested = selectVoice({
    voice: options.voice,
    engine: options.engine,
    defaultVoice: options.defaultVoice,
  });

  const lockDir = join(options.homeDir, "state", "playback");
  const handle = await takeLock(lockDir, options.lockOptions, warn);
  let actual: { engine: Engine; voice: string };
  try {
    actual = await playWithFallback(cleaned, requested, options, warn);
  } finally {
    handle?.release();
  }

  const spokenAt = now();
  const logPath = appendSpokenLine(
    options.homeDir,
    {
      ts: spokenAt.toISOString(),
      session_id: options.sessionId,
      text: spokenText,
      voice: actual.voice,
      engine: actual.engine,
    },
    spokenAt,
  );

  return { spoken_text: spokenText, engine: actual.engine, voice: actual.voice, log_path: logPath };
}

/**
 * A lock we cannot get is not a reason to swallow the sentence: after the timeout we speak
 * anyway and say so. Overlapping speech is recoverable; a lost utterance is not.
 */
async function takeLock(
  lockDir: string,
  lockOptions: LockOptions | undefined,
  warn: (message: string) => void,
) {
  try {
    return await acquireLock(lockDir, lockOptions ?? {});
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
    warn(`bobsay: ${error.message} Speaking anyway — playback may overlap.`);
    return null;
  }
}

async function playWithFallback(
  cleaned: string,
  requested: { engine: Engine; voice: string },
  options: SpeakOptions,
  warn: (message: string) => void,
): Promise<{ engine: Engine; voice: string }> {
  const engine = options.engines[requested.engine];

  if (await engine.available()) {
    try {
      await engine.speak(applyProsody(cleaned, requested.engine), requested.voice);
      return requested;
    } catch (error) {
      if (requested.engine === "say") throw couldNotSpeak("say", error);
      warn(`bobsay: ElevenLabs failed (${describe(error)}) — falling back to the say voice.`);
    }
  } else if (requested.engine === "say") {
    throw couldNotSpeak("say", new Error("the say engine is unavailable"));
  } else {
    warn("bobsay: ElevenLabs is unavailable (no API key?) — falling back to the say voice.");
  }

  const fallback = { engine: "say" as const, voice: fallbackSayVoice(options.defaultVoice) };
  try {
    await options.engines.say.speak(applyProsody(cleaned, "say"), fallback.voice);
    return fallback;
  } catch (error) {
    throw couldNotSpeak("say (fallback)", error);
  }
}

function couldNotSpeak(engine: string, error: unknown): CouldNotSpeakError {
  return new CouldNotSpeakError(`Could not speak through ${engine}: ${describe(error)}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
