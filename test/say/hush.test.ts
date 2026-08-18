import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hush } from "../../src/say/hush.ts";
import {
  interruptionsLogPath,
  pauseMarkerPath,
  playbackLockDir,
  InterruptionRecordSchema,
  PauseMarkerSchema,
  type TicketBody,
} from "../../src/contracts/playback.ts";

let home: string;
let lockDir: string;
/** Signals hush sent, in order: "<pid>:<signal>". */
let signals: string[];
/** Pids the fake process table still considers alive. */
let living: Set<number>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-hush-"));
  lockDir = playbackLockDir(home);
  mkdirSync(lockDir, { recursive: true });
  signals = [];
  living = new Set();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A ticket file whose name encodes its pid, exactly as the lock mints them. */
function ticket(order: number, pid: number, body: TicketBody | null): string {
  const name = `${String(order).padStart(15, "0")}-${String(pid).padStart(7, "0")}-000000.ticket`;
  writeFileSync(join(lockDir, name), body === null ? "" : JSON.stringify(body));
  living.add(pid);
  return name;
}

function holderIs(name: string): void {
  writeFileSync(join(lockDir, "holder.lock"), name);
}

const body = (overrides: Partial<TicketBody> = {}): TicketBody => ({
  session_id: "sess-1",
  answer_id: "a-1",
  remaining_text: "The unspoken tail.",
  ...overrides,
});

/** hush with a fake process table: SIGTERM kills unless the pid is in `stubborn`. */
const run = (options: { stubborn?: number[] } = {}) =>
  hush({
    homeDir: home,
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    kill: (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      const survives = signal === "SIGTERM" && options.stubborn?.includes(pid);
      if (!survives) living.delete(pid);
    },
    alive: (pid) => living.has(pid),
    graceMs: 60,
    pollMs: 5,
  });

const readRecords = () =>
  readFileSync(interruptionsLogPath(home), "utf8")
    .trim()
    .split("\n")
    .map((line) => InterruptionRecordSchema.parse(JSON.parse(line)));

const tickets = () => readdirSync(lockDir).filter((name) => name.endsWith(".ticket"));

describe("hush — nothing is playing", () => {
  test("reports nothing killed, writes no record, but still pauses the queue", async () => {
    const result = await run();

    expect(result.killed).toBe(false);
    expect(signals).toEqual([]);
    expect(existsSync(interruptionsLogPath(home))).toBe(false);
    // The marker goes down from day one, so PTT's contract does not change in M4.
    expect(existsSync(pauseMarkerPath(home))).toBe(true);
  });

  test("a marker naming a ticket that is already gone is not a holder", async () => {
    holderIs("000000000000001-0000001-000000.ticket");
    const result = await run();
    expect(result.killed).toBe(false);
    expect(signals).toEqual([]);
  });
});

describe("hush — a holder is playing", () => {
  test("SIGTERMs the holder and records the unheard tail", async () => {
    const name = ticket(1, 1111, body({ remaining_text: "Second point. Third point." }));
    holderIs(name);

    const result = await run();

    expect(result.killed).toBe(true);
    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(result.session_id).toBe("sess-1");
    expect(result.answer_id).toBe("a-1");

    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      ts: "2026-08-18T12:00:00.000Z",
      session_id: "sess-1",
      answer_id: "a-1",
      // The sentence playing at the moment of the kill heads the tail: unheard by rule.
      interrupted_text: "Second point. Third point.",
      unplayed_texts: [],
    });
  });

  test("the killed holder cleans up after itself — hush does not touch its ticket", async () => {
    const name = ticket(1, 1111, body());
    holderIs(name);
    // The real bobsay removes its own ticket on SIGTERM; the fake table cannot, so the
    // proof is that hush sent no SIGKILL and left the file for its owner to remove.
    await run();
    expect(signals).toEqual(["1111:SIGTERM"]);
  });

  test("a holder that ignores SIGTERM is SIGKILLed, and its ticket and marker are reaped", async () => {
    const name = ticket(1, 1111, body());
    holderIs(name);

    await run({ stubborn: [1111] });

    expect(signals).toEqual(["1111:SIGTERM", "1111:SIGKILL"]);
    expect(tickets()).toEqual([]);
    expect(existsSync(join(lockDir, "holder.lock"))).toBe(false);
  });
});

describe("hush — the answer, not the queue", () => {
  test("queued chunks of the same answer die with it", async () => {
    const first = ticket(1, 1111, body({ remaining_text: "Part one tail." }));
    ticket(2, 2222, body({ remaining_text: "Part two." }));
    holderIs(first);

    const result = await run();

    expect(signals).toEqual(["1111:SIGTERM", "2222:SIGTERM"]);
    expect(tickets()).toEqual([first]); // the waiter's ticket is hush's to remove
    expect(result.unplayed_texts).toEqual(["Part two."]);
    expect(readRecords()[0]!.unplayed_texts).toEqual(["Part two."]);
  });

  test("another session's queued speech survives and plays later", async () => {
    const first = ticket(1, 1111, body());
    const foreign = ticket(2, 2222, body({ session_id: "sess-2", answer_id: "a-2" }));
    holderIs(first);

    const result = await run();

    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(tickets()).toContain(foreign);
    expect(result.unplayed_texts).toEqual([]);
  });

  test("a lone-call answer has no siblings — a null answer id matches nothing", async () => {
    const first = ticket(1, 1111, body({ answer_id: null }));
    const other = ticket(2, 2222, body({ answer_id: null }));
    holderIs(first);

    await run();

    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(tickets()).toContain(other);
  });

  test("a metadata-less ticket is never collateral, whatever the holder carries", async () => {
    const first = ticket(1, 1111, body());
    const old = ticket(2, 2222, null);
    holderIs(first);

    await run();

    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(tickets()).toContain(old);
  });
});

describe("hush — what does not deserve a record", () => {
  test("an interrupted router ack is not an event worth routing on", async () => {
    const name = ticket(1, 1111, body({ session_id: null, answer_id: null }));
    holderIs(name);

    const result = await run();

    expect(result.killed).toBe(true);
    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(existsSync(interruptionsLogPath(home))).toBe(false);
  });

  test("a holder whose body will not parse is killed, but has nothing to record", async () => {
    const name = ticket(1, 1111, null);
    holderIs(name);

    const result = await run();

    expect(result.killed).toBe(true);
    expect(signals).toEqual(["1111:SIGTERM"]);
    expect(existsSync(interruptionsLogPath(home))).toBe(false);
  });
});

describe("hush — the pause marker", () => {
  test("carries the moment it began and a hard deadline three minutes out", async () => {
    const result = await run();
    const marker = PauseMarkerSchema.parse(JSON.parse(readFileSync(pauseMarkerPath(home), "utf8")));

    expect(marker.ts).toBe("2026-08-18T12:00:00.000Z");
    expect(marker.deadline).toBe("2026-08-18T12:03:00.000Z");
    expect(result.paused_until).toBe(marker.deadline);
  });

  test("a second barge-in refreshes the marker rather than stacking one", async () => {
    await run();
    const name = ticket(1, 1111, body());
    holderIs(name);
    await run();

    expect(readdirSync(lockDir).filter((n) => n === "pause.json")).toHaveLength(1);
  });
});
