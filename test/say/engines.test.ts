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
