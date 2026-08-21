import { describe, expect, test } from "bun:test";
import { sayArgs } from "../../src/say/engines/say.ts";
import {
  atrimArgs,
  buildElevenLabsRequest,
  computeTrimEnd,
  resolveApiKey,
  silenceDetectArgs,
  DEFAULT_ELEVENLABS_MODEL,
} from "../../src/say/engines/elevenlabs.ts";
import { SYSTEM_VOICE } from "../../src/say/select.ts";

describe("say engine — argv", () => {
  test("names the voice when there is one", () => {
    expect(sayArgs("Hello there.", "Samantha")).toEqual(["say", "-v", "Samantha", "--", "Hello there."]);
  });

  test("lets macOS choose when the voice is the system sentinel", () => {
    expect(sayArgs("Hello there.", SYSTEM_VOICE)).toEqual(["say", "--", "Hello there."]);
  });

  /**
   * Regression: a sentence may begin with a hyphen. Without the end-of-options marker
   * `say` reads "-5 degrees tonight" as a flag and speaks nothing.
   */
  test("puts the text behind --, so a leading hyphen is spoken rather than parsed", () => {
    const args = sayArgs("-5 degrees tonight", "Samantha");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("-5 degrees tonight");
  });

  test("passes the text as one argument — never through a shell", () => {
    const args = sayArgs('$(rm -rf ~); echo "gotcha"', "Samantha");
    expect(args).toHaveLength(5);
    expect(args.at(-1)).toBe('$(rm -rf ~); echo "gotcha"');
  });
});

describe("elevenlabs engine — request", () => {
  test("targets the voice and carries the key in the xi-api-key header", () => {
    const { url, init } = buildElevenLabsRequest({
      voiceId: "abc123",
      text: "Ready.",
      apiKey: "sk-test",
    });
    expect(url).toContain("/v1/text-to-speech/abc123");
    expect(url).toContain("output_format=mp3_44100_128");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Ready.",
      model_id: DEFAULT_ELEVENLABS_MODEL,
    });
  });

  test("escapes a voice id so it cannot alter the path", () => {
    const { url } = buildElevenLabsRequest({
      voiceId: "../../admin",
      text: "Ready.",
      apiKey: "sk-test",
    });
    expect(url).not.toContain("../../admin");
    expect(url).toContain(encodeURIComponent("../../admin"));
  });

  test("carries voice_settings.speed when the rate is not the default", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Ready.",
      apiKey: "sk-test",
      speed: 1.1,
    });
    expect(JSON.parse(init.body as string).voice_settings).toEqual({ speed: 1.1 });
  });

  test("sends no voice_settings at the default rate — the voice's stored settings rule", () => {
    const plain = buildElevenLabsRequest({ voiceId: "abc", text: "Ready.", apiKey: "sk-test" });
    const unit = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Ready.",
      apiKey: "sk-test",
      speed: 1.0,
    });
    expect(JSON.parse(plain.init.body as string)).not.toHaveProperty("voice_settings");
    expect(unit.init.body).toEqual(plain.init.body);
  });

  test("carries the neighbours for prosody stitching — the sentence is synthesised in its answer", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Second sentence.",
      apiKey: "sk-test",
      previousText: "First sentence.",
      nextText: "Third sentence.",
    });
    const body = JSON.parse(init.body as string);
    expect(body.previous_text).toBe("First sentence.");
    expect(body.next_text).toBe("Third sentence.");
  });

  test("request ids trump previous_text — the API ignores text when ids are sent", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Third sentence.",
      apiKey: "sk-test",
      previousText: "First. Second.",
      nextText: "Fourth.",
      previousRequestIds: ["req-1", "req-2"],
    });
    const body = JSON.parse(init.body as string);
    expect(body.previous_request_ids).toEqual(["req-1", "req-2"]);
    expect(body).not.toHaveProperty("previous_text");
    expect(body.next_text).toBe("Fourth.");
  });

  test("caps the ids at the API's maximum of three, keeping the most recent", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Fifth.",
      apiKey: "sk-test",
      previousRequestIds: ["req-1", "req-2", "req-3", "req-4"],
    });
    expect(JSON.parse(init.body as string).previous_request_ids).toEqual([
      "req-2",
      "req-3",
      "req-4",
    ]);
  });

  test("an empty id list is no id list — previous_text stays in force", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Second.",
      apiKey: "sk-test",
      previousText: "First.",
      previousRequestIds: [],
    });
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("previous_request_ids");
    expect(body.previous_text).toBe("First.");
  });

  test("sends no stitching fields when there are no neighbours — a lone sentence stands alone", () => {
    const { init } = buildElevenLabsRequest({ voiceId: "abc", text: "Ready.", apiKey: "sk-test" });
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("previous_text");
    expect(body).not.toHaveProperty("next_text");
  });

  test("honours a model override", () => {
    const { init } = buildElevenLabsRequest({
      voiceId: "abc",
      text: "Ready.",
      apiKey: "sk-test",
      modelId: "eleven_multilingual_v2",
    });
    expect(JSON.parse(init.body as string).model_id).toBe("eleven_multilingual_v2");
  });
});

describe("elevenlabs engine — trailing-silence trim", () => {
  // Verbatim shape of real ffmpeg silencedetect stderr (measured 2026-08-18: ElevenLabs
  // left 1.12s of trailing silence, ended by a ~20ms codec-edge blip before EOF).
  const detectOutput = [
    "  Duration: 00:00:05.11, start: 0.025057, bitrate: 129 kb/s",
    "[Parsed_silencedetect_0 @ 0x94f008e40] silence_start: 2.540771",
    "[Parsed_silencedetect_0 @ 0x94f008e40] silence_end: 2.588027 | silence_duration: 0.0472562",
    "[Parsed_silencedetect_0 @ 0x94f008e40] silence_start: 3.968481",
    "[Parsed_silencedetect_0 @ 0x94f008e40] silence_end: 5.089342 | silence_duration: 1.120862",
  ].join("\n");

  test("cuts the dead tail but keeps a natural breath, ignoring the codec-edge blip", () => {
    // Last silence starts at 3.968; keep 80ms of it. The 20ms blip after its end
    // (5.089 vs EOF 5.11) is an artifact, not speech — it must not protect the tail.
    expect(computeTrimEnd(detectOutput)).toBeCloseTo(3.968481 + 0.08, 5);
  });

  test("leaves the tail alone when real sound runs to the end", () => {
    const speechToTheEnd = [
      "  Duration: 00:00:05.11, start: 0.025057, bitrate: 129 kb/s",
      "[x] silence_start: 2.5",
      "[x] silence_end: 2.7 | silence_duration: 0.2",
    ].join("\n");
    expect(computeTrimEnd(speechToTheEnd)).toBeNull();
  });

  test("a tail already at natural length is not worth an ffmpeg pass", () => {
    const shortTail = [
      "  Duration: 00:00:04.00, start: 0.025057, bitrate: 129 kb/s",
      "[x] silence_start: 3.91",
      "[x] silence_end: 3.99 | silence_duration: 0.08",
    ].join("\n");
    expect(computeTrimEnd(shortTail)).toBeNull();
  });

  test("no silence, no duration — nothing to do", () => {
    expect(computeTrimEnd("garbage with no markers")).toBeNull();
  });

  test("the two ffmpeg passes carry the right arguments", () => {
    expect(silenceDetectArgs("/tmp/in.mp3").join(" ")).toBe(
      "-hide_banner -i /tmp/in.mp3 -af silencedetect=noise=-45dB:d=0.1 -f null -",
    );
    expect(atrimArgs("/tmp/in.mp3", "/tmp/out.wav", 4.118).join(" ")).toBe(
      "-y -hide_banner -loglevel error -i /tmp/in.mp3 -af atrim=end=4.118 /tmp/out.wav",
    );
  });
});

describe("elevenlabs engine — key resolution", () => {
  test("the environment wins", async () => {
    const key = await resolveApiKey({
      env: { ELEVENLABS_API_KEY: "from-env" },
      readKeychain: async () => "from-keychain",
    });
    expect(key).toBe("from-env");
  });

  test("falls back to the Keychain", async () => {
    const key = await resolveApiKey({ env: {}, readKeychain: async () => "from-keychain" });
    expect(key).toBe("from-keychain");
  });

  test("returns null when there is no key anywhere — the caller falls back audibly", async () => {
    expect(await resolveApiKey({ env: {}, readKeychain: async () => null })).toBeNull();
  });

  test("an empty or whitespace value counts as absent", async () => {
    expect(await resolveApiKey({ env: { ELEVENLABS_API_KEY: "  " }, readKeychain: async () => null }))
      .toBeNull();
  });

  test("a Keychain lookup that blows up is not fatal", async () => {
    const key = await resolveApiKey({
      env: {},
      readKeychain: async () => {
        throw new Error("security: not found");
      },
    });
    expect(key).toBeNull();
  });
});
