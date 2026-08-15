/**
 * The ElevenLabs engine: synthesise, drop the audio in a temp file, play it with `afplay`.
 *
 * `afplay` has no stdin mode, so the mp3 is buffered to disk and removed afterwards.
 * Anything that goes wrong here throws — the caller's job is to fall back to `say`
 * audibly, so this module never degrades quietly on its own.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakTuning, SpeechEngine } from "./engine.ts";

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
}): { url: string; init: RequestInit } {
  // At the default rate no voice_settings go out at all: the voice's stored settings
  // stay authoritative, and the request is byte-identical to the pre-speed era.
  const overridesRate = options.speed !== undefined && options.speed !== 1.0;
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
      }),
    },
  };
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
  async speak(text: string, voice: string, tuning?: SpeakTuning): Promise<void> {
    const apiKey = await resolveApiKey({});
    if (apiKey === null) throw new Error("no ELEVENLABS_API_KEY in the environment or Keychain");

    const { url, init } = buildElevenLabsRequest({
      voiceId: voice,
      text,
      apiKey,
      modelId: nonEmpty(process.env.ELEVENLABS_MODEL_ID) ?? undefined,
      speed: tuning?.speed,
    });

    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`ElevenLabs returned ${response.status} ${response.statusText}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new Error("ElevenLabs returned no audio");

    await playAudio(audio);
  },
};

async function playAudio(audio: Uint8Array): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bobsay-"));
  const file = join(dir, "speech.mp3");
  try {
    writeFileSync(file, audio);
    const player = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([player.exited, new Response(player.stderr).text()]);
    if (code !== 0) {
      throw new Error(`afplay exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
