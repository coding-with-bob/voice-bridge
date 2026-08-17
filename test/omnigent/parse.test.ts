import { describe, expect, test } from "bun:test";
import {
  parsePoolSession,
  parseSessionList,
  parseSessionState,
  parseTextItems,
} from "../../src/omnigent/parse.ts";

const rawSession = {
  id: "conv_abc",
  agent_id: "ag_1",
  agent_name: "claude-native-ui",
  status: "idle",
  created_at: 1786742233,
  updated_at: 1786742238,
  title: "coldstart-measure",
  workspace: "/private/tmp/omnigent-spike",
  host_id: "host_1",
  archived: false,
  pending_elicitations_count: 0,
};

describe("parsePoolSession", () => {
  test("keeps the fields routing actually uses", () => {
    expect(parsePoolSession(rawSession)).toEqual({
      id: "conv_abc",
      title: "coldstart-measure",
      workspace: "/private/tmp/omnigent-spike",
      status: "idle",
      agent_name: "claude-native-ui",
      created_at: 1786742233,
      updated_at: 1786742238,
      archived: false,
      host_id: "host_1",
      pending_elicitations: 0,
    });
  });

  test("an unknown status degrades to 'unknown' rather than throwing — the alpha moves fast", () => {
    expect(parsePoolSession({ ...rawSession, status: "hibernating" })?.status).toBe("unknown");
    expect(parsePoolSession({ ...rawSession, status: undefined })?.status).toBe("unknown");
  });

  test("tolerates a data-wrapped payload", () => {
    expect(parsePoolSession({ data: rawSession })?.id).toBe("conv_abc");
  });

  test("fills in the optional fields that routing can live without", () => {
    const sparse = parsePoolSession({ id: "conv_x", created_at: 1 });
    expect(sparse).toMatchObject({
      id: "conv_x",
      title: null,
      workspace: null,
      updated_at: null,
      archived: false,
      pending_elicitations: 0,
    });
  });

  test("returns null when there is no id — an unaddressable session is not a session", () => {
    expect(parsePoolSession({ title: "nameless" })).toBeNull();
    expect(parsePoolSession(null)).toBeNull();
    expect(parsePoolSession("nonsense")).toBeNull();
  });
});

describe("parseSessionList", () => {
  test("reads the paginated envelope", () => {
    const sessions = parseSessionList({ object: "list", data: [rawSession, rawSession] });
    expect(sessions).toHaveLength(2);
  });

  test("accepts a bare array too", () => {
    expect(parseSessionList([rawSession])).toHaveLength(1);
  });

  test("drops unusable entries instead of failing the whole list", () => {
    const sessions = parseSessionList({ data: [rawSession, { title: "nameless" }, null] });
    expect(sessions).toHaveLength(1);
  });

  test("an unrecognised envelope yields an empty list, not a crash", () => {
    expect(parseSessionList({ unexpected: true })).toEqual([]);
    expect(parseSessionList(null)).toEqual([]);
  });
});

describe("parseTextItems", () => {
  const items = {
    data: [
      { id: "1", type: "resource_event", created_at: 1, resource_id: "terminal_claude_main" },
      {
        id: "2",
        type: "message",
        role: "user",
        created_at: 2,
        content: [{ type: "input_text", text: "Reply with exactly the word: pong" }],
      },
      {
        id: "3",
        type: "message",
        role: "assistant",
        created_at: 3,
        content: [{ type: "output_text", text: "pong" }],
      },
    ],
  };

  test("keeps only the message turns a peek is interested in", () => {
    expect(parseTextItems(items)).toEqual([
      { id: "2", role: "user", text: "Reply with exactly the word: pong", created_at: 2 },
      { id: "3", role: "assistant", text: "pong", created_at: 3 },
    ]);
  });

  test("joins multi-part content", () => {
    const joined = parseTextItems({
      data: [
        {
          id: "1",
          type: "message",
          role: "assistant",
          created_at: 1,
          content: [{ type: "output_text", text: "first" }, { type: "output_text", text: "second" }],
        },
      ],
    });
    expect(joined[0]!.text).toBe("first second");
  });

  test("skips messages with no text at all", () => {
    expect(
      parseTextItems({
        data: [{ id: "1", type: "message", role: "assistant", created_at: 1, content: [] }],
      }),
    ).toEqual([]);
  });

  test("tolerates a plain string content field", () => {
    expect(
      parseTextItems({
        data: [{ id: "1", type: "message", role: "assistant", created_at: 1, content: "plain" }],
      })[0]!.text,
    ).toBe("plain");
  });
});

describe("parseSessionState — the repair's view of a session", () => {
  /**
   * Status alone cannot tell a sleeping session from a live idle one — both report "idle"
   * (probed live, 2026-08-17). What separates them is runner_online, and the difference
   * matters: posting the disregard note to a stopped session revives it, spawning a
   * process just to be told to ignore something.
   */
  test("reads runner_online, since status says idle for asleep and awake alike", () => {
    const asleep = parseSessionState({ status: "idle", pending_inputs: [], runner_online: false });
    expect(asleep.runner_online).toBe(false);
    const awake = parseSessionState({ status: "idle", pending_inputs: [], runner_online: true });
    expect(awake.runner_online).toBe(true);
  });

  test("a snapshot without liveness reads as unknown, never as asleep", () => {
    const state = parseSessionState({ status: "idle", pending_inputs: [] });
    expect(state.runner_online).toBeNull();
  });
});
