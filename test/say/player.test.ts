import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlayer } from "../../src/say/player.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-player-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runPlayer", () => {
  test("resolves when the player exits cleanly", async () => {
    await expect(runPlayer(["/bin/sh", "-c", "exit 0"])).resolves.toBeUndefined();
  });

  test("a nonzero exit throws, naming the player and its complaint", async () => {
    await expect(runPlayer(["/bin/sh", "-c", "echo bad file >&2; exit 3"])).rejects.toThrow(
      /sh exited 3: bad file/,
    );
  });

  test("a silent failure still names the exit code", async () => {
    await expect(runPlayer(["/bin/sh", "-c", "exit 7"])).rejects.toThrow(/sh exited 7$/);
  });
});

describe("a signalled bobsay silences its player (C1)", () => {
  const fixture = join(import.meta.dir, "..", "fixtures", "player-holder.ts");

  async function startHolder(pidFile: string) {
    const child = Bun.spawn(["bun", fixture, pidFile], { stdout: "pipe", stderr: "inherit" });
    const started = Date.now();
    while (!existsSync(pidFile) && Date.now() - started < 10_000) await sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    return child;
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("SIGTERM kills the player child, not just the bobsay process", async () => {
    const pidFile = join(dir, "player.pid");
    const holder = await startHolder(pidFile);
    const playerPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(playerPid)).toBe(true);

    holder.kill("SIGTERM");
    await holder.exited;
    await sleep(200);

    // Without the C1 obligation the player would keep talking to an empty room.
    expect(isAlive(playerPid)).toBe(false);
  }, 30_000);

  test("SIGINT — the Ctrl-C an impatient person types — does the same", async () => {
    const pidFile = join(dir, "player.pid");
    const holder = await startHolder(pidFile);
    const playerPid = Number(readFileSync(pidFile, "utf8").trim());

    holder.kill("SIGINT");
    await holder.exited;
    await sleep(200);

    expect(isAlive(playerPid)).toBe(false);
  }, 30_000);
});
