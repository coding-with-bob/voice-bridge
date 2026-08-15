/**
 * An interrupted holder must give its ticket back.
 *
 * Stale pruning already covers a process that dies without warning, but it is a 60-second
 * net — measured at 58.5 s before this was fixed. Interrupt a `bobsay` mid-sentence and the
 * next utterance would sit silent for a minute with nothing to explain itself, which is the
 * worst shape a delay can take in a system whose whole output is sound.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../../src/say/lock.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-lock-sig-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const holder = join(import.meta.dir, "..", "fixtures", "lock-holder.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHolder(lockDir: string) {
  const child = Bun.spawn(["bun", holder, lockDir], { stdout: "pipe", stderr: "inherit" });
  // Wait for it to announce that it holds the lock, not merely that it started.
  const reader = child.stdout.getReader();
  const started = Date.now();
  let announced = "";
  while (!announced.includes("holding") && Date.now() - started < 15_000) {
    const { value, done } = await reader.read();
    if (done) break;
    announced += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  expect(announced).toContain("holding");
  return child;
}

describe("an interrupted holder", () => {
  test(
    "gives its ticket back on SIGTERM, so the next caller is not left waiting",
    async () => {
      const lockDir = join(dir, "lock");
      const child = await startHolder(lockDir);
      expect(readdirSync(lockDir)).toHaveLength(1);

      child.kill("SIGTERM");
      await child.exited;
      await sleep(150);

      expect(readdirSync(lockDir)).toHaveLength(0);

      // And the proof that matters: the next acquire is immediate, not stale-pruned.
      const started = Date.now();
      const handle = await acquireLock(lockDir, { pollMs: 5, timeoutMs: 5_000 });
      const waited = Date.now() - started;
      handle.release();
      expect(waited).toBeLessThan(1_000);
    },
    30_000,
  );

  test(
    "does the same on SIGINT — the Ctrl-C an impatient person actually types",
    async () => {
      const lockDir = join(dir, "lock");
      const child = await startHolder(lockDir);

      child.kill("SIGINT");
      await child.exited;
      await sleep(150);

      expect(readdirSync(lockDir)).toHaveLength(0);
    },
    30_000,
  );
});
