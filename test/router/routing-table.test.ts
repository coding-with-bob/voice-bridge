/**
 * The routing regression table, run against a mocked model.
 *
 * Set `BOB_ROUTING_LIVE=1` to replay the same table against the real `router_model` instead.
 * That mode is deliberately manual — it costs real calls and is meant for the M6 acceptance
 * run and for after any prompt edit, never for CI. Its pass rule is looser on purpose: a row
 * fails only if it fails **twice consecutively**, because one unlucky sample from a
 * non-deterministic model is not a regression.
 */
import { describe, expect, test } from "bun:test";
import {
  ROUTING_TABLE,
  runCase,
  resolveExpectedCwd,
  type RoutingCase,
  type RunOutcome,
} from "./routing-table.ts";
import { PROMPT_VERSION } from "../../src/router/prompt.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";

const LIVE = process.env.BOB_ROUTING_LIVE === "1";
const LIVE_TIMEOUT_MS = 180_000;

if (LIVE) {
  console.warn(
    `routing table running LIVE — model ${DEFAULT_CONFIG.router_model}, prompt ${PROMPT_VERSION}`,
  );
}

/** Every invariant the row promises, checked together: action, target and flags. */
function assertRow(testCase: RoutingCase, outcome: RunOutcome, live: boolean): void {
  const { result } = outcome;
  expect(result.decision.action).toBe(testCase.expect.action);

  if (testCase.expect.session_id !== undefined) {
    expect(result.target_session_id).toBe(testCase.expect.session_id);
    if (testCase.expect.corrects !== undefined) {
      // A correction also messages the session that received the mistake, telling it to
      // disregard — so the request is the last message rather than the only one.
      expect(outcome.messages.at(-1)?.id).toBe(testCase.expect.session_id);
    } else {
      expect(outcome.messages.map((message) => message.id)).toEqual([testCase.expect.session_id]);
    }
  }

  if (testCase.expect.cwd !== undefined) {
    const expected = resolveExpectedCwd(testCase.expect.cwd, outcome.homeDir);
    expect(outcome.created.map((created) => created.workspace)).toEqual([expected]);
    // Every birth states its model. A row that expects none is expecting the configured
    // default — never "whatever the machine happened to be set to".
    expect(outcome.created[0]?.model).toBe(testCase.expect.model ?? DEFAULT_CONFIG.session_model);
  }

  // Naming a model is an instruction about the launch, not part of the work. If it survives
  // into the request, the session is told to do something about Fable.
  for (const word of testCase.expect.requestExcludes ?? []) {
    for (const message of outcome.messages) expect(message.text).not.toContain(word);
  }

  if (testCase.expect.corrects !== undefined) {
    // What matters is the durable identity: the correction resolved to the right dispatch,
    // whatever per-invocation id the model used to name it.
    expect(result.correction?.of_ts ?? null).toBe(testCase.expect.corrects);
  }

  if (testCase.expect.reachback !== undefined) {
    expect(result.reachback).toBe(testCase.expect.reachback);
  }

  // A clarify must never have touched the pool, whatever route it took to get there.
  if (testCase.expect.action === "clarify") {
    expect(outcome.messages).toEqual([]);
    expect(outcome.created).toEqual([]);
    expect(result.executed).toBe(false);
  }

  // The ack is what a misroute is caught by, so the kind of destination has to be audible in
  // it. This is an invariant of the action, not of the row — no row has to opt in. Live only:
  // in mocked mode the acks are ours, and asserting our own fixtures proves nothing.
  if (live && testCase.expect.action !== "clarify") {
    // `\b` is ASCII-only in JS, so `\búj` never matches "Új session" at the start of a
    // sentence. Anchor on start-or-space instead, and keep the `u` flag for case folding.
    const announcesNew = /(?:^|\s)(?:new|új)\s+session/iu.test(result.spoken);
    expect(announcesNew).toBe(testCase.expect.action === "new");
  }

  if (!live && testCase.mockExpect !== undefined) {
    if (testCase.mockExpect.peeked !== undefined) {
      expect(result.peeked).toBe(testCase.mockExpect.peeked);
    }
    if (testCase.mockExpect.fallback !== undefined) {
      expect(result.fallback).toBe(testCase.mockExpect.fallback);
    }
  }
}

describe.if(!LIVE)("routing table (mocked model — orchestration)", () => {
  for (const testCase of ROUTING_TABLE) {
    test(testCase.name, async () => {
      assertRow(testCase, await runCase(testCase, { live: false }), false);
    });
  }

  test("every row states a target or is a clarify — no half-specified expectations", () => {
    for (const testCase of ROUTING_TABLE) {
      const specified =
        testCase.expect.action === "clarify" ||
        // An undo dispatches nowhere; what it must state is which exchange it undoes.
        (testCase.expect.action === "undo" && testCase.expect.corrects !== undefined) ||
        testCase.expect.session_id !== undefined ||
        testCase.expect.cwd !== undefined;
      expect(specified).toBe(true);
    }
  });
});

describe.if(LIVE)("routing table (live model — routing quality)", () => {
  for (const testCase of ROUTING_TABLE.filter((row) => row.mockOnly !== true)) {
    test(
      testCase.name,
      async () => {
        try {
          assertRow(testCase, await runCase(testCase, { live: true }), true);
        } catch (firstFailure) {
          // Twice consecutively, or it is a sample rather than a regression.
          console.warn(`live row "${testCase.name}" failed once, retrying: ${String(firstFailure)}`);
          assertRow(testCase, await runCase(testCase, { live: true }), true);
        }
      },
      LIVE_TIMEOUT_MS,
    );
  }
});
