import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  readTickets,
  DEFAULT_WAIT_CEILING_MS,
  LockTimeoutError,
} from "../../src/say/lock.ts";
import { MAX_SPOKEN_CHARS } from "../../src/say/clean.ts";
import { parseTicketBody } from "../../src/contracts/playback.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fast = { pollMs: 5 };

describe("acquireLock — mutual exclusion", () => {
  test("a second acquirer waits for the first to release", async () => {
    const events: string[] = [];

    const first = await acquireLock(dir, fast);
    const second = acquireLock(dir, fast).then((handle) => {
      events.push("second-in");
      handle.release();
    });

    await sleep(30);
    events.push("first-out");
    first.release();
    await second;

    expect(events).toEqual(["first-out", "second-in"]);
  });

  test("holders never overlap under contention", async () => {
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        acquireLock(dir, fast).then(async (handle) => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(10);
          inside -= 1;
          handle.release();
        }),
      ),
    );

    expect(maxInside).toBe(1);
  });

  test("releasing twice is harmless", async () => {
    const handle = await acquireLock(dir, fast);
    handle.release();
    handle.release();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("acquireLock — FIFO", () => {
  test("waiters are served in arrival order", async () => {
    const served: number[] = [];
    const held = await acquireLock(dir, fast);

    const waiters: Promise<void>[] = [];
    for (const index of [1, 2, 3]) {
      waiters.push(
        acquireLock(dir, fast).then((handle) => {
          served.push(index);
          handle.release();
        }),
      );
      await sleep(10); // stagger arrivals so the order under test is a real one
    }

    held.release();
    await Promise.all(waiters);

    expect(served).toEqual([1, 2, 3]);
  });
});

describe("acquireLock — crash recovery", () => {
  test("a ticket left behind by a dead process is pruned, not waited on forever", async () => {
    const orphan = join(dir, "000000000000001-0000001-0-orphan.ticket");
    writeFileSync(orphan, "");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(orphan, longAgo, longAgo);

    const handle = await acquireLock(dir, { ...fast, staleMs: 60_000, timeoutMs: 2_000 });
    handle.release();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("a live holder is not pruned mid-sentence — its ticket keeps a heartbeat", async () => {
    const held = await acquireLock(dir, { ...fast, staleMs: 60 });
    // Without the heartbeat the waiter would declare the holder stale after 60ms and steal
    // the lock well before its 250ms deadline; timing out is the proof that it does not.
    await expect(acquireLock(dir, { ...fast, staleMs: 60, timeoutMs: 250 })).rejects.toThrow(
      LockTimeoutError,
    );
    held.release();
  });
});

describe("acquireLock — ticket bodies (C7)", () => {
  const body = { session_id: "sess-1", answer_id: "a-1", remaining_text: "Still to speak." };

  test("the ticket carries its body as JSON while held", async () => {
    const handle = await acquireLock(dir, { ...fast, body });
    const tickets = readdirSync(dir);
    expect(tickets).toHaveLength(1);
    expect(parseTicketBody(readFileSync(join(dir, tickets[0]!), "utf8"))).toEqual(body);
    handle.release();
  });

  test("a waiting ticket carries its body too — hush must see queued metadata", async () => {
    const held = await acquireLock(dir, { ...fast, body });
    const waiterBody = { session_id: "sess-2", answer_id: null, remaining_text: "Queued." };
    const waiter = acquireLock(dir, { ...fast, body: waiterBody }).then((h) => h.release());
    await sleep(30);

    const bodies = readTickets(dir).map((t) => t.body);
    expect(bodies).toContainEqual(body);
    expect(bodies).toContainEqual(waiterBody);

    held.release();
    await waiter;
  });

  test("without a body the ticket is written empty, as before", async () => {
    const handle = await acquireLock(dir, fast);
    const tickets = readdirSync(dir);
    expect(readFileSync(join(dir, tickets[0]!), "utf8")).toBe("");
    handle.release();
  });
});

describe("LockHandle.rewriteBody", () => {
  test("the holder can rewrite its body — remaining_text shrinks at sentence boundaries", async () => {
    const handle = await acquireLock(dir, {
      ...fast,
      body: { session_id: "s", answer_id: null, remaining_text: "One. Two." },
    });
    handle.rewriteBody({ session_id: "s", answer_id: null, remaining_text: "Two." });

    expect(readTickets(dir)[0]!.body?.remaining_text).toBe("Two.");
    handle.release();
  });

  test("rewriting after release is a no-op — no ticket resurrection", async () => {
    const handle = await acquireLock(dir, {
      ...fast,
      body: { session_id: "s", answer_id: null, remaining_text: "One." },
    });
    handle.release();
    handle.rewriteBody({ session_id: "s", answer_id: null, remaining_text: "ghost" });
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe("readTickets", () => {
  test("returns name, pid from the filename, and the parsed body, in FIFO order", async () => {
    writeFileSync(
      join(dir, "000000000000002-0000042-000000.ticket"),
      JSON.stringify({ session_id: null, answer_id: null, remaining_text: "second" }),
    );
    writeFileSync(join(dir, "000000000000001-0000007-000000.ticket"), "");

    const tickets = readTickets(dir);
    expect(tickets.map((t) => t.pid)).toEqual([7, 42]);
    expect(tickets[0]!.name).toBe("000000000000001-0000007-000000.ticket");
    expect(tickets[0]!.body).toBeNull(); // old-format empty body: metadata-less, not an error
    expect(tickets[1]!.body?.remaining_text).toBe("second");
  });

  test("ignores non-ticket files — pause.json shares the directory", () => {
    writeFileSync(join(dir, "pause.json"), "{}");
    expect(readTickets(dir)).toEqual([]);
  });

  test("an empty or missing directory reads as an empty queue", () => {
    expect(readTickets(join(dir, "nope"))).toEqual([]);
  });
});

describe("acquireLock — timeout", () => {
  test("gives up with a typed error instead of hanging forever", async () => {
    const held = await acquireLock(dir, fast);
    await expect(acquireLock(dir, { ...fast, timeoutMs: 60 })).rejects.toThrow(LockTimeoutError);
    held.release();
  });

  test("a timed-out waiter removes its own ticket so it does not block the queue", async () => {
    const held = await acquireLock(dir, fast);
    await acquireLock(dir, { ...fast, timeoutMs: 60 }).catch(() => {});
    held.release();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("the default ceiling outlives a queue of maximum-length spoken answers", () => {
    // The deadline only ever fires against a LIVE holder — a dead one is pruned by the
    // stale net within a minute — so it must exceed legitimate playback, not race it.
    // The 120s era timed out mid-queue once content-length speech existed (2026-08-15).
    const GENEROUS_MS_PER_CHAR = 150; // observed ElevenLabs rate ≈ 90-100 ms per character
    expect(DEFAULT_WAIT_CEILING_MS).toBeGreaterThanOrEqual(
      2 * MAX_SPOKEN_CHARS * GENEROUS_MS_PER_CHAR,
    );
  });
});
