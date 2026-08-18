/**
 * The ElevenLabs engine: synthesise, drop the audio in a temp file, play it with `afplay`.
 *
 * `afplay` has no stdin mode, so the mp3 is buffered to disk and removed afterwards.
 * Anything that goes wrong here throws — the caller's job is to fall back to `say`
 * audibly, so this module never degrades quietly on its own.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedSpeech, SpeakTuning, SpeechEngine } from "./engine.ts";

const API_ROOT = "https://api.elevenlabs.io/v1/text-to-speech";
const OUTPUT_FORMAT = "mp3_44100_128";

/** Fast and multilingual — a voice bridge is judged on latency. Override with ELEVENLABS_MODEL_ID. */
export const DEFAULT_ELEVENLABS_MODEL = "eleven_flash_v2_5";

export const KEYCHAIN_SERVICE = "ELEVENLABS_API_KEY";

export function buildElevenLabsRequest(options: {
  voiceId: string;
  text: string;
  apiKey: string;
  modelId?: string;
  speed?: number;
  /** The sentences of the same answer already spoken — prosody stitching context. */
  previousText?: string;
  /** The sentences of the same answer still to come. */
  nextText?: string;
  /** Ids of the answer's earlier generations — request stitching, capped at the API's 3. */
  previousRequestIds?: string[];
}): { url: string; init: RequestInit } {
  // At the default rate no voice_settings go out at all: the voice's stored settings
  // stay authoritative, and the request is byte-identical to the pre-speed era.
  const overridesRate = options.speed !== undefined && options.speed !== 1.0;
  // The API ignores previous_text when request ids are present, so send one or the other.
  const requestIds = (options.previousRequestIds ?? []).slice(-3);
  return {
    url: `${API_ROOT}/${encodeURIComponent(options.voiceId)}?output_format=${OUTPUT_FORMAT}`,
    init: {
      method: "POST",
      headers: {
        "xi-api-key": options.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: options.text,
        model_id: options.modelId ?? DEFAULT_ELEVENLABS_MODEL,
        ...(overridesRate ? { voice_settings: { speed: options.speed } } : {}),
        // Stitching: the model synthesises the sentence *in* its answer, not as a
        // standalone line — independently synthesised sentences reset intonation.
        ...(requestIds.length > 0
          ? { previous_request_ids: requestIds }
          : options.previousText
            ? { previous_text: options.previousText }
            : {}),
        ...(options.nextText ? { next_text: options.nextText } : {}),
      }),
    },
  };
}

/**
 * ElevenLabs bakes dead air into the clips — measured 2026-08-18 at 0.28-1.12 s of
 * trailing silence per sentence, which was the audible gap between chunked sentences.
 * Two deterministic ffmpeg passes fix it: silencedetect finds the last silence, atrim
 * cuts the tail while keeping a natural breath. (The one-pass silenceremove/areverse
 * trick fails here: the clips end in a ~20 ms above-threshold codec blip, so the
 * reversed stream does not *start* with silence and nothing gets removed.)
 */
const TRIM_KEEP_TAIL_S = 0.15;
/** A blip this close to EOF is codec noise, not speech — it must not protect the tail. */
const TRIM_EDGE_TOLERANCE_S = 0.05;

export function silenceDetectArgs(input: string): string[] {
  return ["-hide_banner", "-i", input, "-af", "silencedetect=noise=-45dB:d=0.1", "-f", "null", "-"];
}

export function atrimArgs(input: string, output: string, end: number): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-af", `atrim=end=${end}`, output];
}

/**
 * Where to cut the tail, from silencedetect's stderr — or null when there is nothing
 * worth cutting (speech runs to the end, tail already natural, output unparseable).
 */
export function computeTrimEnd(detectOutput: string): number | null {
  const duration = parseDuration(detectOutput);
  if (duration === null) return null;

  const starts = [...detectOutput.matchAll(/silence_start: ([\d.]+)/g)];
  const ends = [...detectOutput.matchAll(/silence_end: ([\d.]+)/g)];
  if (starts.length === 0 || ends.length === 0) return null;
  const lastStart = Number.parseFloat(starts[starts.length - 1]![1]!);
  const lastEnd = Number.parseFloat(ends[ends.length - 1]![1]!);

  if (duration - lastEnd > TRIM_EDGE_TOLERANCE_S) return null; // real sound after the silence
  const end = lastStart + TRIM_KEEP_TAIL_S;
  if (end >= duration - TRIM_EDGE_TOLERANCE_S) return null; // nothing meaningful to cut
  return end;
}

function parseDuration(detectOutput: string): number | null {
  const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(detectOutput);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** ffmpeg is optional — PATH first, then the usual Homebrew homes. Null means no trim. */
function resolveFfmpeg(): string | null {
  const found = Bun.which("ffmpeg");
  if (found !== null) return found;
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Trim the trailing silence into a wav next to the mp3. Returns the file to play: the
 * trimmed wav, or the original when ffmpeg is missing, fails, or finds nothing to cut —
 * the sentence must still play; the gap is an annoyance and never worth a lost
 * utterance. Runs inside prepare, so for a prefetched sentence the two passes hide
 * behind the previous sentence's playback.
 */
async function trimEdgeSilence(input: string, output: string): Promise<string> {
  const ffmpeg = resolveFfmpeg();
  if (ffmpeg === null) return input;
  try {
    const detect = Bun.spawn([ffmpeg, ...silenceDetectArgs(input)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [detectCode, detectOutput] = await Promise.all([
      detect.exited,
      new Response(detect.stderr).text(),
    ]);
    if (detectCode !== 0) return input;

    const end = computeTrimEnd(detectOutput);
    if (end === null) return input;

    const trim = Bun.spawn([ffmpeg, ...atrimArgs(input, output, end)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await trim.exited) !== 0) return input;
    return existsSync(output) ? output : input;
  } catch {
    return input;
  }
}

export async function resolveApiKey(options: {
  env?: Record<string, string | undefined>;
  readKeychain?: () => Promise<string | null>;
}): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv = nonEmpty(env.ELEVENLABS_API_KEY);
  if (fromEnv !== null) return fromEnv;

  const readKeychain = options.readKeychain ?? readKeychainSecret;
  try {
    return nonEmpty(await readKeychain());
  } catch {
    return null; // no Keychain entry, or the user declined the prompt
  }
}

async function readKeychainSecret(): Promise<string | null> {
  const process = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return code === 0 ? nonEmpty(stdout) : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export const elevenLabsEngine: SpeechEngine = {
  name: "elevenlabs",
  available: async () => (await resolveApiKey({})) !== null,
  // prepare does the whole network round trip, so a prefetched sentence is a local mp3
  // by the time its turn comes — playback back-to-back, no synthesis gap between sentences.
  async prepare(text: string, voice: string, tuning?: SpeakTuning): Promise<PreparedSpeech> {
    const apiKey = await resolveApiKey({});
    if (apiKey === null) throw new Error("no ELEVENLABS_API_KEY in the environment or Keychain");

    const { url, init } = buildElevenLabsRequest({
      voiceId: voice,
      text,
      apiKey,
      modelId: nonEmpty(process.env.ELEVENLABS_MODEL_ID) ?? undefined,
      speed: tuning?.speed,
      previousText: tuning?.previousText,
      nextText: tuning?.nextText,
      previousRequestIds: tuning?.previousRequestIds,
    });

    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`ElevenLabs returned ${response.status} ${response.statusText}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new Error("ElevenLabs returned no audio");

    const dir = mkdtempSync(join(tmpdir(), "bobsay-"));
    const raw = join(dir, "speech.mp3");
    writeFileSync(raw, audio);
    const file = await trimEdgeSilence(raw, join(dir, "speech.wav"));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    return {
      // Safe to condition on: the generation completed — the body is fully read above.
      requestId: response.headers.get("request-id") ?? undefined,
      async play() {
        try {
          const player = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "pipe" });
          const [code, stderr] = await Promise.all([
            player.exited,
            new Response(player.stderr).text(),
          ]);
          if (code !== 0) {
            throw new Error(`afplay exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
          }
        } finally {
          cleanup();
        }
      },
      dispose: cleanup,
    };
  },
};
