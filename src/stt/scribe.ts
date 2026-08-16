/**
 * ElevenLabs Scribe — the STT side of the voice bridge (PTT v2).
 *
 * D10 named "the Whisper API" for this slot, but the constraint behind that wording
 * was cloud STT that survives the Hungarian/English mix with zero local model build.
 * Scribe satisfies it with the key that already lives in this machine's Keychain
 * (the same ELEVENLABS_API_KEY the TTS engine resolves), where Whisper would need an
 * OpenAI account this machine does not have. If mixed-language quality disappoints,
 * Whisper is a drop-in swap behind `transcribeFile` — plus one owner-provided key.
 */
import { z } from "zod";

const API_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** Override with ELEVENLABS_STT_MODEL_ID (mirrors the TTS engine's ELEVENLABS_MODEL_ID). */
export const DEFAULT_SCRIBE_MODEL = "scribe_v2";

export function buildScribeRequest(options: {
  audio: Blob;
  filename: string;
  apiKey: string;
  modelId?: string;
}): { url: string; init: RequestInit } {
  const body = new FormData();
  body.set("model_id", options.modelId ?? DEFAULT_SCRIBE_MODEL);
  body.set("file", new File([options.audio], options.filename));
  return {
    url: API_URL,
    // No content-type here on purpose: fetch writes it with the multipart boundary.
    init: { method: "POST", headers: { "xi-api-key": options.apiKey }, body },
  };
}

/** Tolerant of everything Scribe adds (words, timings, probabilities); strict about text. */
const ScribeResponseSchema = z.looseObject({
  text: z.string(),
  language_code: z.string().optional(),
});

export interface Transcript {
  text: string;
  languageCode: string | null;
}

export function parseScribeResponse(raw: unknown): Transcript {
  const parsed = ScribeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`ElevenLabs STT returned an unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return { text: parsed.data.text, languageCode: parsed.data.language_code ?? null };
}

/** Loose on purpose: tests inject a plain async function, not Bun's full fetch object. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export async function transcribeFile(options: {
  filePath: string;
  apiKey: string;
  modelId?: string;
  fetchImpl?: FetchLike;
}): Promise<Transcript> {
  const file = Bun.file(options.filePath);
  if (!(await file.exists())) {
    throw new Error(`no audio file at ${options.filePath}`);
  }

  const { url, init } = buildScribeRequest({
    audio: new Blob([await file.arrayBuffer()]),
    filename: options.filePath.split("/").at(-1) ?? "utterance.wav",
    apiKey: options.apiKey,
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
  });

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, init);
  if (!response.ok) {
    throw new Error(`ElevenLabs STT returned ${response.status}: ${await serverWords(response)}`);
  }
  return parseScribeResponse(await response.json());
}

/** The API explains its refusals in JSON; surface its words rather than just the code. */
async function serverWords(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const detail = (JSON.parse(raw) as { detail?: { message?: string } }).detail;
    return detail?.message ?? raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}
