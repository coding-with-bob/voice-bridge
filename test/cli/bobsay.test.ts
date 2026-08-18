import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spokenLogPathFor } from "../../src/contracts/spoken-log.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const bobsay = join(import.meta.dir, "..", "..", "src", "cli", "bobsay.ts");

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", bobsay, ...args], {
    env: { ...process.env, BOB_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const noLogWasWritten = () => expect(existsSync(spokenLogPathFor(home, new Date()))).toBe(false);

describe("bobsay — calls rejected before any audio (exit 2)", () => {
  test("text that cleans down to nothing", async () => {
    const { code, stderr } = await run(["```\njust code\n```"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Nothing speakable");
    noLogWasWritten();
  });

  test("a malformed voice reference", async () => {
    const { code, stderr } = await run(["--voice", "festival:bob", "Ready."]);
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid voice");
    noLogWasWritten();
  });

  test("--engine contradicting --voice", async () => {
    const { code, stderr } = await run(["--engine", "say", "--voice", "elevenlabs:abc", "Ready."]);
    expect(code).toBe(2);
    expect(stderr).toContain("contradicts");
    noLogWasWritten();
  });

  test("an unknown engine", async () => {
    const { code, stderr } = await run(["--engine", "festival", "Ready."]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown engine");
  });

  test("a broken defaults.yaml — the error names the file", async () => {
    writeFileSync(join(home, "defaults.yaml"), "gc_idle_hours: -1\n");
    const { code, stderr } = await run(["Ready."]);
    expect(code).toBe(2);
    expect(stderr).toContain("defaults.yaml");
    expect(stderr).toContain("gc_idle_hours");
  });

  test("--engine elevenlabs with no ElevenLabs voice configured", async () => {
    const { code, stderr } = await run(["--engine", "elevenlabs", "Ready."]);
    expect(code).toBe(2);
    expect(stderr).toContain("--voice elevenlabs:");
  });
});

describe("bobsay — usage", () => {
  test("--help exits 0 and documents the C1 flags", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    for (const flag of ["--session", "--answer", "--voice", "--engine", "--json"]) {
      expect(stdout).toContain(flag);
    }
  });

  test("missing text is a usage error", async () => {
    const { code } = await run([]);
    expect(code).not.toBe(0);
  });
});
