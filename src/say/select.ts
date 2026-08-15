/**
 * Voice and engine selection (C1).
 *
 * Explicit beats configured, and a contradiction between `--voice` and `--engine` is an
 * error rather than a silent pick — guessing which one the caller meant is how a session
 * ends up speaking in the wrong voice with nobody knowing why.
 */
import type { Engine } from "../contracts/spoken-log.ts";

/** Sentinel: let macOS pick its system voice (`say` invoked without `-v`). */
export const SYSTEM_VOICE = "system";

export class VoiceSelectionError extends Error {
  override name = "VoiceSelectionError";
}

export interface VoiceChoice {
  engine: Engine;
  voice: string;
}

const ENGINES: readonly Engine[] = ["elevenlabs", "say"];

export function parseVoiceRef(ref: string): VoiceChoice {
  const separator = ref.indexOf(":");
  const engine = separator === -1 ? "" : ref.slice(0, separator);
  const voice = separator === -1 ? "" : ref.slice(separator + 1);
  if (!isEngine(engine) || voice === "") {
    throw new VoiceSelectionError(
      `Invalid voice "${ref}": expected "elevenlabs:<voice-id>" or "say:<voice-name>".`,
    );
  }
  return { engine, voice };
}

export function selectVoice(options: {
  voice?: string;
  engine?: string;
  defaultVoice: string;
}): VoiceChoice {
  const requestedEngine = options.engine === undefined ? undefined : asEngine(options.engine);

  if (options.voice !== undefined) {
    const chosen = parseVoiceRef(options.voice);
    if (requestedEngine !== undefined && requestedEngine !== chosen.engine) {
      throw new VoiceSelectionError(
        `--engine ${requestedEngine} contradicts --voice ${options.voice}. Pass one or the other.`,
      );
    }
    return chosen;
  }

  const configured = parseVoiceRef(options.defaultVoice);
  if (requestedEngine === undefined || requestedEngine === configured.engine) {
    return requestedEngine === undefined ? configured : { ...configured, engine: requestedEngine };
  }

  // Engine forced, and the configured voice belongs to the other engine.
  if (requestedEngine === "say") return { engine: "say", voice: SYSTEM_VOICE };
  throw new VoiceSelectionError(
    `--engine elevenlabs needs an ElevenLabs voice: pass --voice elevenlabs:<voice-id> ` +
      `or set default_voice in defaults.yaml (currently "${options.defaultVoice}").`,
  );
}

/**
 * The voice the audible ElevenLabs fallback speaks in. Deliberately total: the fallback
 * exists for the case where things are already going wrong, so it must not add a failure.
 */
export function fallbackSayVoice(defaultVoice: string): string {
  try {
    const configured = parseVoiceRef(defaultVoice);
    return configured.engine === "say" ? configured.voice : SYSTEM_VOICE;
  } catch {
    return SYSTEM_VOICE;
  }
}

function isEngine(value: string): value is Engine {
  return (ENGINES as readonly string[]).includes(value);
}

function asEngine(value: string): Engine {
  if (!isEngine(value)) {
    throw new VoiceSelectionError(`Unknown engine "${value}": expected elevenlabs or say.`);
  }
  return value;
}
