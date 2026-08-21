import { describe, expect, test } from "bun:test";
import {
  TicketBodySchema,
  InterruptionRecordSchema,
  PauseMarkerSchema,
  parseTicketBody,
  playbackLockDir,
  pauseMarkerPath,
  interruptionsLogPath,
  PAUSE_DEADLINE_MS,
} from "../../src/contracts/playback.ts";

describe("C7 ticket body", () => {
  const body = {
    session_id: "sess-1",
    answer_id: "a-1755500000",
    remaining_text: "The part still to be spoken.",
  };

  test("round-trips through JSON", () => {
    expect(parseTicketBody(JSON.stringify(body))).toEqual(body);
  });

  test("accepts null session and answer ids (sessionless, single-call answers)", () => {
    const parsed = TicketBodySchema.parse({ ...body, session_id: null, answer_id: null });
    expect(parsed.session_id).toBeNull();
    expect(parsed.answer_id).toBeNull();
  });

  test("an old-format empty ticket parses to null, not an error — it must not wedge the queue", () => {
    expect(parseTicketBody("")).toBeNull();
  });

  test("malformed bodies parse to null: bad JSON, missing fields, wrong types", () => {
    expect(parseTicketBody("{not json")).toBeNull();
    expect(parseTicketBody(JSON.stringify({ session_id: "s" }))).toBeNull();
    expect(parseTicketBody(JSON.stringify({ ...body, remaining_text: 42 }))).toBeNull();
  });
});

describe("C7 interruption record", () => {
  const record = {
    ts: "2026-08-18T10:00:00.000Z",
    session_id: "sess-1",
    answer_id: "a-1",
    interrupted_text: "The sentence that was cut. And everything after it.",
    unplayed_texts: ["A queued sibling chunk that never played."],
  };

  test("accepts a complete record", () => {
    expect(InterruptionRecordSchema.parse(record).unplayed_texts).toHaveLength(1);
  });

  test("accepts null ids and an empty unplayed list — a lone-call answer has no siblings", () => {
    const parsed = InterruptionRecordSchema.parse({
      ...record,
      session_id: null,
      answer_id: null,
      unplayed_texts: [],
    });
    expect(parsed.answer_id).toBeNull();
    expect(parsed.unplayed_texts).toEqual([]);
  });

  test("requires a timestamp", () => {
    const { ts: _dropped, ...rest } = record;
    expect(() => InterruptionRecordSchema.parse(rest)).toThrow();
  });
});

describe("C7 pause marker", () => {
  test("accepts ts + deadline", () => {
    const parsed = PauseMarkerSchema.parse({
      ts: "2026-08-18T10:00:00.000Z",
      deadline: "2026-08-18T10:03:00.000Z",
    });
    expect(parsed.deadline).toBe("2026-08-18T10:03:00.000Z");
  });

  test("rejects a marker without a deadline — expiry is the crash safety net", () => {
    expect(() => PauseMarkerSchema.parse({ ts: "2026-08-18T10:00:00.000Z" })).toThrow();
  });

  test("the default deadline is 180 seconds", () => {
    expect(PAUSE_DEADLINE_MS).toBe(180_000);
  });
});

describe("C7 paths", () => {
  test("the lock dir, the pause marker, and the interruption log all hang off the state home", () => {
    expect(playbackLockDir("/Users/sam/bob")).toBe("/Users/sam/bob/state/playback");
    expect(pauseMarkerPath("/Users/sam/bob")).toBe("/Users/sam/bob/state/playback/pause.json");
    expect(interruptionsLogPath("/Users/sam/bob")).toBe(
      "/Users/sam/bob/logs/interruptions.jsonl",
    );
  });
});
