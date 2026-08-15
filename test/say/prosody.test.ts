import { describe, expect, test } from "bun:test";
import { applyProsody } from "../../src/say/prosody.ts";

describe("applyProsody — plain (what the ledger records)", () => {
  test("removes emphasis markers, keeps the words", () => {
    expect(applyProsody("The build **passed** and it was *close*.", "plain")).toBe(
      "The build passed and it was close.",
    );
  });

  test("leaves an ellipsis as written", () => {
    expect(applyProsody("Done... finally.", "plain")).toBe("Done... finally.");
  });

  test("leaves text without markers untouched", () => {
    expect(applyProsody("Nothing to do here.", "plain")).toBe("Nothing to do here.");
  });

  test("leaves underscores alone", () => {
    expect(applyProsody("route_decisions.jsonl is written", "plain")).toBe(
      "route_decisions.jsonl is written",
    );
  });
});

describe("applyProsody — say", () => {
  test("turns bold into an emphasis command pair", () => {
    expect(applyProsody("The build **passed**.", "say")).toBe(
      "The build [[emph +]]passed[[emph -]].",
    );
  });

  test("turns single-asterisk emphasis into the same pair", () => {
    expect(applyProsody("That was *close*.", "say")).toBe("That was [[emph +]]close[[emph -]].");
  });

  test("turns an ellipsis into a silence command", () => {
    expect(applyProsody("Done... finally.", "say")).toBe("Done[[slnc 350]] finally.");
  });

  test("neutralises stray square brackets so they cannot be read as commands", () => {
    expect(applyProsody("The [[slnc 9000]] trick", "say")).toBe("The slnc 9000 trick");
  });
});

describe("applyProsody — elevenlabs", () => {
  test("drops the markers and lets the model do the prosody", () => {
    expect(applyProsody("The build **passed**.", "elevenlabs")).toBe("The build passed.");
  });

  test("keeps the ellipsis, which the model already renders as a pause", () => {
    expect(applyProsody("Done... finally.", "elevenlabs")).toBe("Done... finally.");
  });
});
