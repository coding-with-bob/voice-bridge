import type { Engine } from "../../contracts/spoken-log.ts";

/** Delivery adjustments an engine may honour or ignore — never a reason to fail. */
export interface SpeakTuning {
  /** Speech rate multiplier; 1.0 (or absence) means the voice's own pace. */
  speed?: number;
  /** Prosody stitching: the same answer's sentences already spoken. Engines may ignore it. */
  previousText?: string;
  /** Prosody stitching: the same answer's sentences still to come. */
  nextText?: string;
}

/**
 * One synthesised utterance, ready to play. `play` resolves when the audio has finished
 * playing and throws when it did not play — there is no in-between, because the C2 log
 * line is written on the strength of that resolution. `dispose` frees buffered audio
 * without playing it (a prefetched sentence overtaken by fallback or interruption);
 * calling it after `play` is harmless.
 */
export interface PreparedSpeech {
  play(): Promise<void>;
  dispose(): void;
}

/**
 * A speech engine, in two phases so the pipeline can synthesise sentence i+1 while
 * sentence i plays. `prepare` does the synthesis work and throws when the sentence
 * cannot be made playable; the returned handle plays on demand.
 */
export interface SpeechEngine {
  readonly name: Engine;
  /** Whether the engine can be used at all right now (keys present, binary installed). */
  available(): boolean | Promise<boolean>;
  prepare(text: string, voice: string, tuning?: SpeakTuning): Promise<PreparedSpeech>;
}

export type EngineRegistry = Record<Engine, SpeechEngine>;
