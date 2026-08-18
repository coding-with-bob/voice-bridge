import { describe, expect, test } from "bun:test";
import { sayArgs } from "../../src/say/engines/say.ts";
import {
  buildElevenLabsRequest,
  resolveApiKey,
  DEFAULT_ELEVENLABS_MODEL,
} from "../../src/say/engines/elevenlabs.ts";
import { SYSTEM_VOICE } from "../../src/say/select.ts";

describe("say engine — argv", () => {
  test("names the voice when there is one", () => {
    expect(sayArgs("Hello there.", "Tünde")).toEqual(["say", "-v", "Tünde", "--", "Hello there."]);
  });

  test("lets macOS choose when the voice is the system sentinel", () => {
    expect(sayArgs("Hello there.", SYSTEM_VOICE)).toEqual(["say", "--", "Hello there."]);
  });

  /**
   * Regression: a sentence may begin with a hyphen. Without the end-of-options marker
   * `say` reads "-5 degrees tonight" as a flag and speaks nothing.
   */
  test("puts the text behind --, so a leading hyphen is spoken rather than parsed", () => {
    const args = sayArgs("-5 degrees tonight", "Tünde");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("-5 degrees tonight");
  });

  test("passes the text as one argument — never through a shell", () => {
    const args = sayArgs('$(rm -rf ~); echo "gotcha"', "Tünde");
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
