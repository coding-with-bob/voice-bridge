import { describe, expect, test } from "bun:test";
import { capForSpeech, cleanForSpeech, MAX_SPOKEN_CHARS } from "../../src/say/clean.ts";

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

describe("cleanForSpeech — no cap of its own", () => {
  test("cleaning is a pure transform: long text passes through whole", () => {
    const text = "word ".repeat(3 * MAX_SPOKEN_CHARS).trim();
    expect(cleanForSpeech(text)).toBe(text);
  });
});

describe("capForSpeech — the runaway guard", () => {
  test("leaves text at or under the cap untouched and reports nothing dropped", () => {
    const text = "a".repeat(MAX_SPOKEN_CHARS);
    expect(capForSpeech(text)).toEqual({ text, dropped: 0 });
  });

  test("cuts overlong text at a word boundary, marks the cut, and counts what fell", () => {
    const raw = "word ".repeat(2 * MAX_SPOKEN_CHARS).trim();
    const { text, dropped } = capForSpeech(raw);
    expect(text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("wor…");
    expect(dropped).toBe(raw.length - (text.length - "…".length));
  });

  test("the cap fits real spoken content — a two-minute recap is not a runaway", () => {
    // The 600-char era cut a movie recap mid-sentence (2026-08-15). The cap is
    // runaway protection now, not a format rule: whole paragraphs must fit.
    expect(MAX_SPOKEN_CHARS).toBeGreaterThanOrEqual(5_000);
  });
});
