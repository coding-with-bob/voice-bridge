import { describe, expect, test } from "bun:test";
import { splitSentences } from "../../src/say/sentences.ts";

describe("splitSentences — the boundaries the plan pins", () => {
  test("splits after . ! ? followed by whitespace", () => {
    expect(splitSentences("The build passed. All tests are green! Ready?")).toEqual([
      "The build passed.",
      "All tests are green!",
      "Ready?",
    ]);
  });

  test("splits after an ellipsis followed by whitespace", () => {
    expect(splitSentences("Well… let me think. Done.")).toEqual([
      "Well…",
      "let me think.",
      "Done.",
    ]);
  });

  test("Hungarian text splits the same way", () => {
    expect(
      splitSentences("Kész vagyok a feladattal. A tesztek zöldek, minden átment! Folytassam?"),
    ).toEqual(["Kész vagyok a feladattal.", "A tesztek zöldek, minden átment!", "Folytassam?"]);
  });

  test("newlines are sentence whitespace too — paragraphs split cleanly", () => {
    expect(splitSentences("First paragraph ends here.\n\nSecond one starts.")).toEqual([
      "First paragraph ends here.",
      "Second one starts.",
    ]);
  });

  test("a run of terminators is one boundary", () => {
    expect(splitSentences("Really?! Yes.")).toEqual(["Really?!", "Yes."]);
  });
});

describe("splitSentences — where it must NOT split", () => {
  test("not inside a number", () => {
    expect(splitSentences("The rate is 3.5 percent. Good.")).toEqual([
      "The rate is 3.5 percent.",
      "Good.",
    ]);
  });

  test("not after a single-letter initial", () => {
    expect(splitSentences("E. W. Dijkstra wrote it. Read it.")).toEqual([
      "E. W. Dijkstra wrote it.",
      "Read it.",
    ]);
  });

  test("a comma is not a boundary — sub-sentence splitting is deliberately out of scope", () => {
    expect(splitSentences("First clause, second clause, third clause.")).toEqual([
      "First clause, second clause, third clause.",
    ]);
  });
});

describe("splitSentences — edges", () => {
  test("text without a final terminator still yields its last sentence", () => {
    expect(splitSentences("Done. And one more thing")).toEqual(["Done.", "And one more thing"]);
  });

  test("a single sentence comes back whole", () => {
    expect(splitSentences("Just one sentence.")).toEqual(["Just one sentence."]);
  });

  test("empty and whitespace-only input yield nothing", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("  \n ")).toEqual([]);
  });

  test("prosody markers ride along untouched — rendering happens later, per engine", () => {
    expect(splitSentences("The build **passed**. Next step.")).toEqual([
      "The build **passed**.",
      "Next step.",
    ]);
  });
});
