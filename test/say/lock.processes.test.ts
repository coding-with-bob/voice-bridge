import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-lock-proc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const worker = join(import.meta.dir, "..", "fixtures", "lock-worker.ts");

describe("playback lock across processes", () => {
  test("two parallel invocations do not overlap", async () => {
    const lockDir = join(dir, "lock");
    const record = join(dir, "record.txt");
    writeFileSync(record, "");

    const exits = await Promise.all(
      ["A", "B"].map((label) =>
        Bun.spawn(["bun", worker, lockDir, record, label, "150"], {
          stdout: "ignore",
          stderr: "inherit",
        }).exited,
      ),
    );
    expect(exits).toEqual([0, 0]);

    const events = readFileSync(record, "utf8").trim().split("\n");
    expect(events).toHaveLength(4);
    // Whoever wins the race, the pattern must be in/out/in/out — never in/in.
    expect(events[0]!.startsWith("in ")).toBe(true);
    expect(events[1]).toBe(`out ${events[0]!.slice(3)}`);
    expect(events[2]!.startsWith("in ")).toBe(true);
    expect(events[3]).toBe(`out ${events[2]!.slice(3)}`);
    expect(events[0]).not.toBe(events[2]);
  }, 15_000);
});
