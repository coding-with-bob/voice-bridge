import { describe, expect, test } from "bun:test";
import { separatePositional } from "../../src/cli/argv.ts";

const bobsay = {
  booleanOptions: ["--json", "-h", "--help", "-V", "--version"],
  valueOptions: ["--session", "--voice", "--engine"],
};
const bob = { ...bobsay, valueOptions: ["-n", "--count"], skipPositionals: 1 };

describe("separatePositional — text that begins with a dash", () => {
  test("protects it, so a sentence starting with a hyphen can still be spoken", () => {
    expect(separatePositional(["-5 degrees tonight"], bobsay)).toEqual([
      "--",
      "-5 degrees tonight",
    ]);
  });

  test("protects it after options and their values", () => {
    expect(separatePositional(["--session", "s1", "--json", "-5 degrees"], bobsay)).toEqual([
      "--session",
      "s1",
      "--json",
      "--",
      "-5 degrees",
    ]);
  });

  test("handles the --opt=value form without swallowing the text", () => {
    expect(separatePositional(["--session=s1", "-5 degrees"], bobsay)).toEqual([
      "--session=s1",
      "--",
      "-5 degrees",
    ]);
  });

  test("skips the verb for a CLI with subcommands", () => {
    expect(separatePositional(["route", "--json", "-5 degrees"], bob)).toEqual([
      "route",
      "--json",
      "--",
      "-5 degrees",
    ]);
  });
});

describe("separatePositional — leaves everything else exactly as it was", () => {
  test("ordinary text needs no separator", () => {
    const argv = ["--session", "s1", "The build passed."];
    expect(separatePositional(argv, bobsay)).toBe(argv);
  });

  test("a caller who already wrote -- is trusted", () => {
    const argv = ["--", "-5 degrees"];
    expect(separatePositional(argv, bobsay)).toBe(argv);
  });

  test("options with no text at all", () => {
    expect(separatePositional(["--help"], bobsay)).toEqual(["--help"]);
    expect(separatePositional([], bobsay)).toEqual([]);
  });

  test("a verb with no text", () => {
    expect(separatePositional(["doctor", "--json"], bob)).toEqual(["doctor", "--json"]);
  });

  test("a genuinely unknown option before any text still reaches commander", () => {
    // It gets separated rather than silently accepted; commander then reports it as text,
    // which is the honest outcome — we cannot know the caller meant an option.
    expect(separatePositional(["--nonsense"], bobsay)).toEqual(["--", "--nonsense"]);
  });

  test("a bare dash is text, not an option", () => {
    expect(separatePositional(["-"], bobsay)).toEqual(["--", "-"]);
  });
});
