import { describe, expect, test } from "bun:test";
import {
  parseVoiceRef,
  selectVoice,
  fallbackSayVoice,
  SYSTEM_VOICE,
  VoiceSelectionError,
} from "../../src/say/select.ts";

describe("parseVoiceRef", () => {
  test("splits engine from voice", () => {
    expect(parseVoiceRef("elevenlabs:abc123")).toEqual({ engine: "elevenlabs", voice: "abc123" });
    expect(parseVoiceRef("say:Samantha")).toEqual({ engine: "say", voice: "Samantha" });
  });

  test("keeps colons inside the voice id", () => {
    expect(parseVoiceRef("elevenlabs:a:b")).toEqual({ engine: "elevenlabs", voice: "a:b" });
  });

  test("rejects an unknown engine or a missing half", () => {
    expect(() => parseVoiceRef("festival:bob")).toThrow(VoiceSelectionError);
    expect(() => parseVoiceRef("Samantha")).toThrow(VoiceSelectionError);
    expect(() => parseVoiceRef("say:")).toThrow(VoiceSelectionError);
  });
});

describe("selectVoice", () => {
  const sayDefault = "say:Samantha";
  const elevenDefault = "elevenlabs:abc123";

  test("falls back to the configured default when nothing is asked for", () => {
    expect(selectVoice({ defaultVoice: sayDefault })).toEqual({ engine: "say", voice: "Samantha" });
  });

  test("--voice wins over the default", () => {
    expect(selectVoice({ voice: "elevenlabs:xyz", defaultVoice: sayDefault })).toEqual({
      engine: "elevenlabs",
      voice: "xyz",
    });
  });

  test("--voice and a matching --engine agree", () => {
    expect(
      selectVoice({ voice: "say:Daniel", engine: "say", defaultVoice: elevenDefault }),
    ).toEqual({ engine: "say", voice: "Daniel" });
  });

  test("--voice and a contradicting --engine is a hard error, not a silent pick", () => {
    expect(() =>
      selectVoice({ voice: "elevenlabs:xyz", engine: "say", defaultVoice: sayDefault }),
    ).toThrow(VoiceSelectionError);
  });

  test("--engine alone keeps the default's voice when the engines match", () => {
    expect(selectVoice({ engine: "say", defaultVoice: sayDefault })).toEqual({
      engine: "say",
      voice: "Samantha",
    });
  });

  test("--engine say with an ElevenLabs default falls back to the system voice", () => {
    expect(selectVoice({ engine: "say", defaultVoice: elevenDefault })).toEqual({
      engine: "say",
      voice: SYSTEM_VOICE,
    });
  });

  test("--engine elevenlabs with no ElevenLabs voice anywhere is an explained error", () => {
    expect(() => selectVoice({ engine: "elevenlabs", defaultVoice: sayDefault })).toThrow(
      /--voice elevenlabs:/,
    );
  });
});

describe("fallbackSayVoice", () => {
  test("reuses the configured say voice when there is one", () => {
    expect(fallbackSayVoice("say:Samantha")).toBe("Samantha");
  });

  test("uses the system voice when the default is an ElevenLabs one", () => {
    expect(fallbackSayVoice("elevenlabs:abc123")).toBe(SYSTEM_VOICE);
  });

  test("never throws, even on a malformed default — the fallback must always be able to speak", () => {
    expect(fallbackSayVoice("nonsense")).toBe(SYSTEM_VOICE);
  });
});
