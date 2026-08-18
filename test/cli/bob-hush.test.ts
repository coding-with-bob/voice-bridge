import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseMarkerPath } from "../../src/contracts/playback.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-hush-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const bob = join(import.meta.dir, "..", "..", "src", "cli", "bob.ts");

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", bob, ...args], {
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

describe("bob hush", () => {
  test("with nothing playing: exits 0, reports killed: false, and pauses the queue", async () => {
    const { code, stdout } = await run(["hush", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ killed: false, recorded: false });
    expect(existsSync(pauseMarkerPath(home))).toBe(true);
  });

  test("says in plain words that nothing was playing", async () => {
    const { code, stdout } = await run(["hush"]);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing was playing");
  });
});

describe("bob resume", () => {
  test("lifts a standing pause", async () => {
    await run(["hush"]);
    const { code, stdout } = await run(["resume", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ lifted: true });
    expect(existsSync(pauseMarkerPath(home))).toBe(false);
  });

  test("is harmless when there is no pause to lift", async () => {
    const { code, stdout } = await run(["resume", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ lifted: false });
  });
});
