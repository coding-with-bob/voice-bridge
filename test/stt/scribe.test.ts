import { describe, expect, test } from "bun:test";
import {
  buildScribeRequest,
  parseScribeResponse,
  transcribeFile,
  DEFAULT_SCRIBE_MODEL,
} from "../../src/stt/scribe.ts";

describe("scribe — request", () => {
  test("posts multipart to the speech-to-text endpoint with the key in xi-api-key", () => {
    const { url, init } = buildScribeRequest({
      audio: new Blob([new Uint8Array([1, 2, 3])]),
      filename: "utterance.wav",
      apiKey: "sk-test",
    });
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-test");

    const body = init.body as FormData;
    expect(body.get("model_id")).toBe(DEFAULT_SCRIBE_MODEL);
    const file = body.get("file") as File;
    expect(file.name).toBe("utterance.wav");
  });

  /**
   * The multipart boundary belongs to fetch: a hand-set content-type would omit it
   * and the server would reject the body. The header must stay absent.
   */
  test("never sets content-type by hand — fetch owns the multipart boundary", () => {
    const { init } = buildScribeRequest({
      audio: new Blob([new Uint8Array([1])]),
      filename: "utterance.wav",
      apiKey: "sk-test",
    });
    const headerNames = Object.keys(init.headers as Record<string, string>).map((h) =>
      h.toLowerCase(),
    );
    expect(headerNames).not.toContain("content-type");
  });

  test("a caller-chosen model id overrides the default", () => {
    const { init } = buildScribeRequest({
      audio: new Blob([new Uint8Array([1])]),
      filename: "utterance.wav",
      apiKey: "sk-test",
      modelId: "scribe_v1",
    });
    expect((init.body as FormData).get("model_id")).toBe("scribe_v1");
  });
});

describe("scribe — response", () => {
  test("keeps the text and the detected language, tolerating extra fields", () => {
    const parsed = parseScribeResponse({
      language_code: "hu",
      language_probability: 0.97,
      text: "Mennyi idő a build?",
      words: [{ text: "Mennyi", type: "word", start: 0, end: 0.4 }],
    });
    expect(parsed).toEqual({ text: "Mennyi idő a build?", languageCode: "hu" });
  });

  test("an empty transcript is a valid answer, not an error — silence happens", () => {
    expect(parseScribeResponse({ text: "" }).text).toBe("");
    expect(parseScribeResponse({ text: "" }).languageCode).toBeNull();
  });

  test("a shape without text is rejected loudly, naming the STT", () => {
    expect(() => parseScribeResponse({ transcript: "wrong key" })).toThrow(/ElevenLabs STT/);
  });
});

describe("scribe — transcribeFile", () => {
  const wavFixture = async (): Promise<string> => {
    const path = `${import.meta.dir}/fixture-utterance.wav`;
    await Bun.write(path, new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])); // "RIFF" stub
    return path;
  };

  test("sends the file bytes and returns the parsed transcript", async () => {
    const seen: { url?: string; hasFile?: boolean } = {};
    const result = await transcribeFile({
      filePath: await wavFixture(),
      apiKey: "sk-test",
      fetchImpl: async (url, init) => {
        seen.url = String(url);
        seen.hasFile = (init?.body as FormData).get("file") instanceof Blob;
        return Response.json({ text: "hello bob", language_code: "en" });
      },
    });
    expect(result).toEqual({ text: "hello bob", languageCode: "en" });
    expect(seen).toEqual({ url: "https://api.elevenlabs.io/v1/speech-to-text", hasFile: true });
  });

  test("a non-ok response throws with the status and the server's own words", async () => {
    await expect(
      transcribeFile({
        filePath: await wavFixture(),
        apiKey: "sk-test",
        fetchImpl: async () =>
          new Response(JSON.stringify({ detail: { message: "invalid model_id" } }), {
            status: 422,
          }),
      }),
    ).rejects.toThrow(/422.*invalid model_id/);
  });

  test("a missing audio file is a setup-shaped error naming the path", async () => {
    await expect(
      transcribeFile({
        filePath: "/nowhere/utterance.wav",
        apiKey: "sk-test",
        fetchImpl: async () => Response.json({ text: "" }),
      }),
    ).rejects.toThrow(/\/nowhere\/utterance\.wav/);
  });
});
