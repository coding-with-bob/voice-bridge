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
  ledger_matches: [],
  peeks: [],
  recent_exchanges: [],
  projects_root: "/Users/felho/dev",
  project_dirs: ["craft", "confpipeline"],
  session_models: ["claude-opus-5", "claude-fable-5"],
  session_model: "claude-opus-5",
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
    const order = [
      "CORRECTION",
      "FOLLOW-UP",
      "CONTENT MATCH",
      "PEEK",
      "LEDGER LOOKUP",
      "NAMED PROJECT",
      "HOME",
      "CLARIFY",
    ];
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

  /**
   * Regression (2026-08-15, first real use): "greet the guest next to me" went to the
   * torrent session — deixis to the room satisfied "does not stand on its own" and the fixed
   * order stopped there. Replayed: the old wording misroutes 3/3, an unconstrained model 0/3.
   * The recipe was the defect, so the recipe now carries the distinction.
   */
  test("a follow-up must continue the conversation's subject, not the room's", () => {
    expect(SYSTEM_PROMPT).toContain("NOT a follow-up");
    expect(SYSTEM_PROMPT).toContain("subject of its own");
    expect(SYSTEM_PROMPT).toContain("about the room");
  });

  test("states that a sleeping session is a normal target", () => {
    expect(SYSTEM_PROMPT).toContain("A sleeping session is a normal target");
  });

  /**
   * The ack is the whole early-warning system for a misroute: the person hears where the
   * request went and corrects by ear. That only works if a new session and a continued one
   * cannot be mistaken for each other — "I've sent it to craft" fits both and so warns of
   * nothing.
   *
   * The binding to the action is stated because a worked example alone is not enough.
   * Observed live (2026-08-16, opus-5): given a Hungarian utterance the model chose the
   * Hungarian *sentence pattern* over its own branch, answering `new` while announcing
   * "Beküldve a sorozat letöltés sessionnek" — a continue, naming the one session in sight.
   * An ack that contradicts the decision is worse than a vague one: it reports a misroute
   * that did not happen and hides the one that did.
   */
  test("the ack separates a new session from a continued one, audibly", () => {
    expect(SYSTEM_PROMPT).toContain("must describe the action you actually chose");
    expect(SYSTEM_PROMPT).toContain("New session: craft.");
    expect(SYSTEM_PROMPT).toContain("Sent to the subtitle session.");
    expect(SYSTEM_PROMPT).toContain('Keep the word "session" untranslated');
  });

  /**
   * A correction has the form of a follow-up and the opposite meaning: it says the last
   * address was wrong. Deliberated before FOLLOW-UP, or the fix is delivered to the very
   * session that received the mistake.
   */
  test("a correction is considered before anything can swallow it as a follow-up", () => {
    expect(SYSTEM_PROMPT.indexOf("CORRECTION")).toBeLessThan(SYSTEM_PROMPT.indexOf("FOLLOW-UP"));
    expect(SYSTEM_PROMPT).toContain("A correction is never a follow-up");
    // Identification is semantic, and refusal to guess is stated, not implied.
    expect(SYSTEM_PROMPT).toContain("identify WHICH exchange");
    expect(SYSTEM_PROMPT).toContain("never guess at what to undo");
    expect(SYSTEM_PROMPT).toContain('"corrects"');
  });

  /**
   * Model choice is a birth property, like placement — so it is offered the same way: a
   * closed list plus "never invent", held to it afterwards by the executability check.
   * It cannot apply to a continue: Omnigent persists `terminal_launch_args` onto the
   * session, so a revived session comes back on the model it was born with.
   */
  test("a model may be asked for by voice, on a new session only", () => {
    expect(SYSTEM_PROMPT).toContain("MODELS YOU MAY BE ASKED FOR");
    expect(SYSTEM_PROMPT).toContain("fixed when it was born");
    expect(SYSTEM_PROMPT).toContain('drop the naming from "request"');
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

  test("renders recent exchanges as linked question-and-answer, oldest first", () => {
    const prompt = buildUserPrompt(
      context({
        recent_exchanges: [
          {
            id: "x1",
            ts: "2026-08-15T11:00:00.000Z",
            minutes_ago: 23,
            utterance: "mi volt a legutolsó sorozat?",
            action: "continue",
            target_session_id: "sess-tv",
            reply: "A Star Trek S04E04 letöltése kész.",
          },
          {
            id: "x2",
            ts: "2026-08-15T11:58:00.000Z",
            minutes_ago: 2,
            utterance: "Hiabob köszönj, Marcinak!",
            action: "clarify",
            target_session_id: null,
            reply: "Melyikre gondolsz?",
          },
        ],
      }),
      "x",
      NOW,
    );
    expect(prompt).toContain("RECENT EXCHANGES");
    // The ids are the correction vocabulary — rendered on every line, explained in the header.
    expect(prompt).toContain('the [xN] ids are what "corrects" refers to');
    expect(prompt).toContain('[x1] 23m ago: "mi volt a legutolsó sorozat?" → continue sess-tv → "A Star Trek S04E04');
    expect(prompt).toContain("[x2] 2m ago:");
    expect(prompt).toContain('→ clarify → "Melyikre gondolsz?"');
    expect(prompt.indexOf("legutolsó sorozat")).toBeLessThan(prompt.indexOf("Hiabob"));
  });

  test("no exchanges section before anything has happened", () => {
    expect(buildUserPrompt(context(), "x", NOW)).not.toContain("RECENT EXCHANGES");
  });

  test("an exchange with no reply yet says so", () => {
    const prompt = buildUserPrompt(
      context({
        recent_exchanges: [
          { id: "x1", ts: "2026-08-15T11:59:00.000Z", minutes_ago: 1, utterance: "u", action: "new", target_session_id: "sess-x", reply: null },
        ],
      }),
      "x",
      NOW,
    );
    expect(prompt).toContain("(no spoken reply yet)");
  });

  test("says nothing about peeks or the ledger until a round has actually happened", () => {
    const prompt = buildUserPrompt(context(), "x", NOW);
    expect(prompt).not.toContain("FOUND IN THE SPOKEN LEDGER");
    expect(prompt).not.toContain("TRANSCRIPT EXTRACTS");
  });

  test("renders ledger matches with the lines that surfaced them", () => {
    const prompt = buildUserPrompt(
      context({
        ledger_matches: [
          {
            id: "july",
            title: "subtitle work",
            workspace: "/Users/felho/dev/craft",
            status: "idle",
            minutes_since_active: 54_000,
            spoken_tail: [],
            matched_lines: ["The subtitle pipeline is done."],
          },
        ],
      }),
      "that subtitle thing from July",
      NOW,
    );
    expect(prompt).toContain("FOUND IN THE SPOKEN LEDGER");
    expect(prompt).toContain("older than the candidate window");
    expect(prompt).toContain("id: july");
    expect(prompt).toContain('matched: "The subtitle pipeline is done."');
  });

  test("renders peek extracts and closes the door on a second round", () => {
    const prompt = buildUserPrompt(
      context({
        peeks: [
          {
            session_id: "s1",
            turns: [
              { role: "user", text: "fix the timing" },
              { role: "assistant", text: "Timing fixed." },
            ],
          },
        ],
      }),
      "the other one too",
      NOW,
    );
    expect(prompt).toContain("TRANSCRIPT EXTRACTS");
    expect(prompt).toContain("user: fix the timing");
    expect(prompt).toContain("assistant: Timing fixed.");
    expect(prompt).toContain("do not ask for another peek");
  });

  test("an empty extract says so rather than showing a blank session", () => {
    const prompt = buildUserPrompt(
      context({ peeks: [{ session_id: "s1", turns: [] }] }),
      "x",
      NOW,
    );
    expect(prompt).toContain("(nothing readable in this transcript)");
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
