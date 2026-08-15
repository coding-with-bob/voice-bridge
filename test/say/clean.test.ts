import { describe, expect, test } from "bun:test";
import { cleanForSpeech, MAX_SPOKEN_CHARS } from "../../src/say/clean.ts";

describe("cleanForSpeech — structural markdown goes away", () => {
  test("drops fenced code blocks entirely", () => {
    const raw = "Done.\n\n```ts\nconst x = 1;\n```\n\nTests pass.";
    expect(cleanForSpeech(raw)).toBe("Done. Tests pass.");
  });

  test("drops a fenced block that is never closed", () => {
    expect(cleanForSpeech("Done.\n\n```\nhalf a block")).toBe("Done.");
  });

  test("unwraps inline code", () => {
    expect(cleanForSpeech("Run `bun test` now.")).toBe("Run bun test now.");
  });

  test("keeps link text and drops the target", () => {
    expect(cleanForSpeech("See [the plan](https://example.com/a_b) for details.")).toBe(
      "See the plan for details.",
    );
  });

  test("strips heading markers, list bullets and blockquotes", () => {
    const raw = "## Result\n\n- first thing\n- second thing\n\n> a quoted note";
    expect(cleanForSpeech(raw)).toBe("Result. first thing. second thing. a quoted note");
  });

  test("strips numbered list markers", () => {
    expect(cleanForSpeech("1. first\n2. second")).toBe("first. second");
  });

  test("strips horizontal rules", () => {
    expect(cleanForSpeech("Done.\n\n---\n\nAll good.")).toBe("Done. All good.");
  });

  test("strips emoji", () => {
    expect(cleanForSpeech("Done ✅ and shipped 🚀")).toBe("Done and shipped");
  });

  test("collapses whitespace into single spaces", () => {
    expect(cleanForSpeech("Done.\n\n\n   Really    done.")).toBe("Done. Really done.");
  });

  test("returns an empty string when nothing speakable is left", () => {
    expect(cleanForSpeech("```\ncode only\n```")).toBe("");
    expect(cleanForSpeech("   \n\n  ")).toBe("");
    expect(cleanForSpeech("🚀")).toBe("");
  });
});

describe("cleanForSpeech — emphasis markers survive for prosody", () => {
  test("keeps bold markers", () => {
    expect(cleanForSpeech("The build **passed**.")).toBe("The build **passed**.");
  });

  test("keeps single-asterisk emphasis", () => {
    expect(cleanForSpeech("That was *close*.")).toBe("That was *close*.");
  });

  test("leaves underscores alone — they are identifier characters, not emphasis", () => {
    expect(cleanForSpeech("Check route_decisions.jsonl")).toBe("Check route_decisions.jsonl");
  });
});

describe("cleanForSpeech — length cap", () => {
  test("leaves normal-length text untouched", () => {
    const text = "A perfectly ordinary spoken summary.";
    expect(cleanForSpeech(text)).toBe(text);
  });

  test("truncates overlong text at a word boundary and marks the cut", () => {
    const cleaned = cleanForSpeech("word ".repeat(400));
    expect(cleaned.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 1);
    expect(cleaned.endsWith("…")).toBe(true);
    expect(cleaned).not.toContain("wor…");
  });
});
