/**
 * The C1 pipeline: clean → select voice → take the playback lock → speak sentence by
 * sentence → log each sentence as it is heard.
 *
 * Invariants that drive the shape of this module:
 *   - the ledger records only what was actually heard, so each sentence's C2 append
 *     happens after that sentence's playback resolves and never before;
 *   - the ticket's remaining_text always starts at the sentence now playing — the
 *     playing sentence counts as unheard until it finishes (C7);
 *   - the ElevenLabs fallback is audible and per answer: the first failure drops the
 *     *rest* of the answer to the macOS voice — mid-answer voice flapping is worse than
 *     a consistent fallback voice — and the log names the engine that really spoke;
 *   - sentence i+1 is synthesised while sentence i plays (prefetch, one ahead — more
 *     buys nothing and risks burning synthesis on an answer about to be barged).
 */
import { capForSpeech, cleanForSpeech, MAX_SPOKEN_CHARS } from "./clean.ts";
import { applyProsody } from "./prosody.ts";
import { splitSentences } from "./sentences.ts";
import { fallbackSayVoice, selectVoice } from "./select.ts";
import { acquireLock, LockTimeoutError, type LockOptions } from "./lock.ts";
import { appendSpokenLine } from "./spoken-log.ts";
import type { EngineRegistry, PreparedSpeech } from "./engines/engine.ts";
import type { Engine } from "../contracts/spoken-log.ts";
import { playbackLockDir, type TicketBody } from "../contracts/playback.ts";

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
  /** The answer this call is a chunk of (C1 --answer); null/absent when the chunk is the answer. */
  answerId?: string | null;
  homeDir: string;
  defaultVoice: string;
  engines: EngineRegistry;
  voice?: string;
  engine?: string;
  /** ElevenLabs speech rate from C3 (`elevenlabs_speed`); engines that cannot honour it ignore it. */
  speed?: number;
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
  /** True when the text ran past the cap and only its head was spoken. Never silent: a warning named the cut. */
  truncated: boolean;
  /** The answer this call was a chunk of, or null (C7). */
  answer_id: string | null;
}

export async function speak(options: SpeakOptions): Promise<SpeakResult> {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.error(message));

  const fullText = cleanForSpeech(options.text);
  if (fullText === "") {
    throw new NothingToSpeakError("Nothing speakable left after cleaning — refusing to speak.");
  }
  const { text: cleaned, dropped } = capForSpeech(fullText);
  if (dropped > 0) {
    warn(
      `bobsay: the text ran ${dropped} characters past the ${MAX_SPOKEN_CHARS}-character cap — ` +
        `only the first part will be spoken. Split long content into paragraph-sized bobsay calls.`,
    );
  }

  const sentences = splitSentences(cleaned);
  const plain = sentences.map((sentence) => applyProsody(sentence, "plain"));
  const answerId = options.answerId ?? null;

  const requested = selectVoice({
    voice: options.voice,
    engine: options.engine,
    defaultVoice: options.defaultVoice,
  });

  const bodyFor = (fromIndex: number): TicketBody => ({
    session_id: options.sessionId,
    answer_id: answerId,
    remaining_text: plain.slice(fromIndex).join(" "),
  });

  const lockDir = playbackLockDir(options.homeDir);
  const handle = await takeLock(lockDir, { ...options.lockOptions, body: bodyFor(0) }, warn);

  let current = requested;
  let fellBack = false;
  let logPath = "";
  let prefetch: Promise<PreparedSpeech> | null = null;
  /** Ids of this answer's completed generations, oldest first — request stitching food. */
  const requestIds: string[] = [];

  const prepareSentence = (index: number): Promise<PreparedSpeech> =>
    options.engines[current.engine].prepare(
      applyProsody(sentences[index]!, current.engine),
      current.voice,
      {
        speed: options.speed,
        // Stitching context (C7/M1): the sentence is synthesised *in* its answer.
        previousText: index > 0 ? plain.slice(0, index).join(" ") : undefined,
        nextText: index + 1 < sentences.length ? plain.slice(index + 1).join(" ") : undefined,
        previousRequestIds: requestIds.length > 0 ? requestIds.slice(-3) : undefined,
      },
    );

  const startPrefetch = (index: number): Promise<PreparedSpeech> => {
    const upcoming = prepareSentence(index);
    upcoming.catch(() => {}); // inspected when the sentence's turn comes, never unhandled
    return upcoming;
  };

  const discard = (overtaken: Promise<PreparedSpeech> | null): void => {
    overtaken?.then((prepared) => prepared.dispose()).catch(() => {});
  };

  /** The per-answer fallback: the first ElevenLabs failure drops the rest to say. */
  const fallBackFor = async (index: number, error: unknown): Promise<PreparedSpeech> => {
    if (current.engine === "say") {
      throw couldNotSpeak(fellBack ? "say (fallback)" : "say", error);
    }
    warn(`bobsay: ElevenLabs failed (${describe(error)}) — falling back to the say voice.`);
    current = { engine: "say", voice: fallbackSayVoice(options.defaultVoice) };
    fellBack = true;
    try {
      return await prepareSentence(index);
    } catch (sayError) {
      throw couldNotSpeak("say (fallback)", sayError);
    }
  };

  try {
    const engine = options.engines[requested.engine];
    if (!(await engine.available())) {
      if (requested.engine === "say") {
        throw couldNotSpeak("say", new Error("the say engine is unavailable"));
      }
      warn("bobsay: ElevenLabs is unavailable (no API key?) — falling back to the say voice.");
      current = { engine: "say", voice: fallbackSayVoice(options.defaultVoice) };
      fellBack = true;
    }

    for (let index = 0; index < sentences.length; index++) {
      let prepared: PreparedSpeech;
      try {
        prepared = await (prefetch ?? prepareSentence(index));
      } catch (error) {
        prepared = await fallBackFor(index, error);
      }
      if (prepared.requestId !== undefined) requestIds.push(prepared.requestId);
      prefetch = index + 1 < sentences.length ? startPrefetch(index + 1) : null;

      try {
        await prepared.play();
      } catch (error) {
        // The prefetched neighbour was synthesised by the failing engine — let it go.
        discard(prefetch);
        prefetch = null;
        const replacement = await fallBackFor(index, error);
        try {
          await replacement.play();
        } catch (sayError) {
          throw couldNotSpeak("say (fallback)", sayError);
        }
        prefetch = index + 1 < sentences.length ? startPrefetch(index + 1) : null;
      }

      const spokenAt = now();
      logPath = appendSpokenLine(
        options.homeDir,
        {
          ts: spokenAt.toISOString(),
          session_id: options.sessionId,
          answer_id: answerId,
          text: plain[index]!,
          voice: current.voice,
          engine: current.engine,
        },
        spokenAt,
      );
      handle?.rewriteBody(bodyFor(index + 1));
    }
  } finally {
    discard(prefetch);
    handle?.release();
  }

  return {
    spoken_text: plain.join(" "),
    engine: current.engine,
    voice: current.voice,
    log_path: logPath,
    truncated: dropped > 0,
    answer_id: answerId,
  };
}

/**
 * A lock we cannot get is not a reason to swallow the sentence: after the timeout we speak
 * anyway and say so. Overlapping speech is recoverable; a lost utterance is not.
 */
async function takeLock(
  lockDir: string,
  lockOptions: LockOptions,
  warn: (message: string) => void,
) {
  try {
    return await acquireLock(lockDir, lockOptions);
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
    warn(`bobsay: ${error.message} Speaking anyway — playback may overlap.`);
    return null;
  }
}

function couldNotSpeak(engine: string, error: unknown): CouldNotSpeakError {
  return new CouldNotSpeakError(`Could not speak through ${engine}: ${describe(error)}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
