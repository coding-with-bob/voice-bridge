import { describe, expect, test } from "bun:test";
import {
  SpokenLogEntrySchema,
  spokenLogPathFor,
  parseSpokenLogLine,
} from "../../src/contracts/spoken-log.ts";

describe("C2 spoken log entry", () => {
  const entry = {
    ts: "2026-08-15T10:00:00.000Z",
    session_id: "sess-1",
    text: "The subtitles are done.",
    voice: "Tünde",
    engine: "say",
  };

  test("accepts a complete entry", () => {
    expect(SpokenLogEntrySchema.parse(entry).session_id).toBe("sess-1");
  });

  test("accepts a null session id (router acks are sessionless)", () => {
    expect(SpokenLogEntrySchema.parse({ ...entry, session_id: null }).session_id).toBeNull();
  });

  test("requires session_id to be present even when null", () => {
    const { session_id: _dropped, ...rest } = entry;
    expect(() => SpokenLogEntrySchema.parse(rest)).toThrow();
  });

  test("rejects an unknown engine", () => {
    expect(() => SpokenLogEntrySchema.parse({ ...entry, engine: "festival" })).toThrow();
  });
});

describe("spokenLogPathFor", () => {
  test("groups by local calendar day under <home>/spoken", () => {
    const path = spokenLogPathFor("/Users/felho/bob", new Date(2026, 7, 15, 23, 30));
    expect(path).toBe("/Users/felho/bob/spoken/2026-08-15.jsonl");
  });

  test("uses local time, not UTC, so an evening line lands on the day it was heard", () => {
    // 2026-08-15 23:30 local (CEST) is already 2026-08-16 in UTC.
    const path = spokenLogPathFor("/Users/felho/bob", new Date("2026-08-15T23:30:00+02:00"));
    expect(path).toBe("/Users/felho/bob/spoken/2026-08-15.jsonl");
  });
});

describe("parseSpokenLogLine", () => {
  test("parses a valid line", () => {
    const line = JSON.stringify({
      ts: "2026-08-15T10:00:00.000Z",
      session_id: null,
      text: "Working on it.",
      voice: "Tünde",
      engine: "say",
    });
    expect(parseSpokenLogLine(line)?.text).toBe("Working on it.");
  });

  test("returns null for a corrupt line instead of throwing — readers must tolerate", () => {
    expect(parseSpokenLogLine("{not json")).toBeNull();
    expect(parseSpokenLogLine(JSON.stringify({ ts: "now" }))).toBeNull();
    expect(parseSpokenLogLine("")).toBeNull();
  });
});
