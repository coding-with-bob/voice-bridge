import type { Engine } from "../../contracts/spoken-log.ts";

/**
 * A speech engine. `speak` resolves when the audio has finished playing and throws when
 * it did not play — there is no in-between, because the C2 log line is written on the
 * strength of that resolution.
 */
export interface SpeechEngine {
  readonly name: Engine;
  /** Whether the engine can be used at all right now (keys present, binary installed). */
  available(): boolean | Promise<boolean>;
  speak(text: string, voice: string): Promise<void>;
}

export type EngineRegistry = Record<Engine, SpeechEngine>;
