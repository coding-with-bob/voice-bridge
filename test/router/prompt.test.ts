import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT, buildUserPrompt } from "../../src/router/prompt.ts";
import type { RoutingContext } from "../../src/router/context.ts";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const context = (overrides: Partial<RoutingContext> = {}): RoutingContext => ({
  candidates: [
    {
      id: "s1",
      title: "subtitle pipeline",
      workspace: "/Users/felho/dev/craft",
      status: "idle",
      minutes_since_active: 4,
      spoken_tail: ["The subtitles are done."],
    },
  ],
  most_recent: {
    session_id: "s1",
    kind: "spoken",
    minutes_ago: 4,
    within_followup_window: true,
  },
  projects_root: "/Users/felho/dev",
  project_dirs: ["craft", "confpipeline"],
  home_dir: "/Users/felho/bob",
  followup_window_min: 30,
  candidate_window_days: 14,
  digest: "1 candidates",
  ...overrides,
});

describe("SYSTEM_PROMPT — the discipline is stated, not implied", () => {
  test("carries the guard against interpreting the domain", () => {
    expect(SYSTEM_PROMPT).toContain("never interpret the domain");
    expect(SYSTEM_PROMPT).toContain("Do not answer the request");
  });

  test("fixes the deliberation order", () => {
    const order = ["FOLLOW-UP", "CONTENT MATCH", "NAMED PROJECT", "HOME", "CLARIFY"];
    const positions = order.map((step) => SYSTEM_PROMPT.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("names all three actions and forbids inventing an address", () => {
    for (const action of ["continue", "new", "clarify"]) {
      expect(SYSTEM_PROMPT).toContain(`"action":"${action}"`);
    }
    expect(SYSTEM_PROMPT).toContain("Never invent");
  });

  test("asks for bare JSON, since anything else has to be salvaged", () => {
    expect(SYSTEM_PROMPT).toContain("exactly one JSON object");
    expect(SYSTEM_PROMPT).toContain("no markdown fences");
  });

  test("states that a sleeping session is a normal target", () => {
    expect(SYSTEM_PROMPT).toContain("A sleeping session is a normal target");
  });
});

describe("buildUserPrompt", () => {
  test("puts the utterance in, verbatim and last", () => {
    const prompt = buildUserPrompt(context(), "and do the other one too", NOW);
    expect(prompt).toContain("and do the other one too");
    expect(prompt.trimEnd().endsWith("and do the other one too")).toBe(true);
  });

  test("shows each candidate with what routing decides on", () => {
    const prompt = buildUserPrompt(context(), "x", NOW);
    expect(prompt).toContain("id: s1");
    expect(prompt).toContain("idle 4m");
    expect(prompt).toContain("/Users/felho/dev/craft");
    expect(prompt).toContain("subtitle pipeline");
    expect(prompt).toContain('spoke: "The subtitles are done."');
  });

  test("flags the most recent interaction and whether it is inside the window", () => {
    expect(buildUserPrompt(context(), "x", NOW)).toContain("INSIDE the follow-up window");
    const stale = context({
      most_recent: { session_id: "s1", kind: "dispatch", minutes_ago: 90, within_followup_window: false },
    });
    const prompt = buildUserPrompt(stale, "x", NOW);
    expect(prompt).toContain("outside the follow-up window");
    expect(prompt).toContain("it was messaged last");
  });

  test("lists the placement vocabulary so no path has to be guessed", () => {
    const prompt = buildUserPrompt(context(), "x", NOW);
    expect(prompt).toContain("- craft");
    expect(prompt).toContain("- confpipeline");
    expect(prompt).toContain("/Users/felho/bob");
  });

  // Regression: the first live run produced cwd "<home>/hey-bob" because the prompt listed
  // bare project names and the only absolute path in sight was the home directory. Names
  // without their root are an invitation to guess.
  test("spells out the absolute form of a placement path, not just the names", () => {
    const prompt = buildUserPrompt(context(), "x", NOW);
    expect(prompt).toContain("/Users/felho/dev/<name>");
    expect(prompt).toContain("/Users/felho/dev/craft");
  });

  test("says plainly when there is nothing to continue", () => {
    const prompt = buildUserPrompt(context({ candidates: [], most_recent: null }), "x", NOW);
    expect(prompt).toContain("(none — the pool is empty)");
    expect(prompt).toContain("MOST RECENT INTERACTION: none");
  });

  test("marks a session that has never spoken, rather than leaving a blank", () => {
    const silent = context({
      candidates: [
        {
          id: "s2",
          title: null,
          workspace: null,
          status: "waiting",
          minutes_since_active: 1,
          spoken_tail: [],
        },
      ],
    });
    const prompt = buildUserPrompt(silent, "x", NOW);
    expect(prompt).toContain("(has not spoken)");
    expect(prompt).toContain("(untitled)");
    expect(prompt).toContain("status: waiting");
  });
});
