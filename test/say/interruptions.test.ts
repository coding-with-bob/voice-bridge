import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { appendInterruption, readLatestInterruption } from "../../src/say/interruptions.ts";
import { interruptionsLogPath, type InterruptionRecord } from "../../src/contracts/playback.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-interruptions-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const record = (overrides: Partial<InterruptionRecord> = {}): InterruptionRecord => ({
  ts: "2026-08-18T12:00:00.000Z",
  session_id: "sess-1",
  answer_id: "a-1",
  interrupted_text: "The unspoken tail.",
  unplayed_texts: [],
  ...overrides,
});

function writeRaw(lines: string[]): void {
  const path = interruptionsLogPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("readLatestInterruption", () => {
  test("returns null when nobody has ever barged in", () => {
    expect(readLatestInterruption(home)).toBeNull();
  });

  test("returns the last record written", () => {
    appendInterruption(home, record({ ts: "2026-08-18T11:00:00.000Z" }));
    appendInterruption(home, record({ ts: "2026-08-18T12:00:00.000Z", session_id: "sess-2" }));

    expect(readLatestInterruption(home)?.session_id).toBe("sess-2");
  });

  test("skips a corrupt tail rather than failing — concurrent writers exist", () => {
    writeRaw([JSON.stringify(record()), '{"ts": "half a line']);
    expect(readLatestInterruption(home)?.session_id).toBe("sess-1");
  });

  test("a file of nothing but garbage reads as no interruption", () => {
    writeRaw(["{not json", ""]);
    expect(readLatestInterruption(home)).toBeNull();
  });
});
