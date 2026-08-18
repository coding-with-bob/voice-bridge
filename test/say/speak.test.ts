import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  speak,
  CouldNotSpeakError,
  NothingToSpeakError,
  type SpeakOptions,
} from "../../src/say/speak.ts";
import type { SpeakTuning, SpeechEngine } from "../../src/say/engines/engine.ts";
import { spokenLogPathFor, parseSpokenLogLine } from "../../src/contracts/spoken-log.ts";
import { parseTicketBody } from "../../src/contracts/playback.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-speak-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Spoken {
  text: string;
  voice: string;
}

interface FakeBehaviour {
  available?: boolean;
  /** Every sentence fails. `failAt` picks the phase (default: prepare). */
  fail?: boolean;
  /** Only the Nth prepare call fails (1-based) — for mid-answer fallback tests. */
  failOnCall?: number;
  failAt?: "prepare" | "play";
  onSpeak?: (text: string) => void;
  playDelayMs?: number;
}

interface FakeEngine extends SpeechEngine {
  spoken: Spoken[];
  /** prepare / play-start / play-end / dispose events, in real order. */
  events: string[];
  tunings: Array<SpeakTuning | undefined>;
}

function fakeEngine(name: "say" | "elevenlabs", behaviour: FakeBehaviour = {}): FakeEngine {
  const spoken: Spoken[] = [];
  const events: string[] = [];
  const tunings: Array<SpeakTuning | undefined> = [];
  let prepareCalls = 0;

  return {
    name,
    spoken,
    events,
    tunings,
    available: () => behaviour.available ?? true,
    async prepare(text: string, voice: string, tuning?: SpeakTuning) {
      prepareCalls += 1;
      const failsThis = behaviour.fail === true || behaviour.failOnCall === prepareCalls;
      events.push(`prepare:${text}`);
      tunings.push(tuning);
      if (failsThis && (behaviour.failAt ?? "prepare") === "prepare") {
        throw new Error(`${name} blew up`);
      }
      return {
        async play() {
          events.push(`play-start:${text}`);
          behaviour.onSpeak?.(text);
          if (behaviour.playDelayMs) await sleep(behaviour.playDelayMs);
          if (failsThis) throw new Error(`${name} blew up`);
          spoken.push({ text, voice });
          events.push(`play-end:${text}`);
        },
        dispose() {
          events.push(`dispose:${text}`);
        },
      };
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseOptions = (
  overrides: Partial<SpeakOptions> & Pick<SpeakOptions, "engines">,
): SpeakOptions => ({
  text: "The build **passed**.",
  sessionId: "sess-1",
  homeDir: home,
  defaultVoice: "say:Tünde",
  lockOptions: { pollMs: 5 },
  ...overrides,
});

const readLog = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map(parseSpokenLogLine);

describe("speak — the happy path", () => {
  test("speaks through the selected engine and reports what was said", async () => {
    const say = fakeEngine("say");
    const result = await speak(baseOptions({ engines: { say, elevenlabs: fakeEngine("elevenlabs") } }));

    expect(result.engine).toBe("say");
    expect(result.voice).toBe("Tünde");
    expect(result.spoken_text).toBe("The build passed.");
    expect(say.spoken).toHaveLength(1);
    // The engine gets prosody markup; the ledger and --json get the plain sentence.
    expect(say.spoken[0]!.text).toBe("The build [[emph +]]passed[[emph -]].");
  });

  test("appends exactly one C2 line, with what was actually heard", async () => {
    const result = await speak(baseOptions({ engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") } }));

    expect(result.log_path).toBe(spokenLogPathFor(home, new Date()));
    const entries = readLog(result.log_path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      session_id: "sess-1",
      text: "The build passed.",
      voice: "Tünde",
      engine: "say",
    });
  });

  test("a sessionless call — a router ack — logs session_id: null", async () => {
    const result = await speak(
      baseOptions({
        sessionId: null,
        engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") },
      }),
    );
    expect(readLog(result.log_path)[0]!.session_id).toBeNull();
  });

  test("cleans markdown out before speaking", async () => {
    const say = fakeEngine("say");
    const result = await speak(
      baseOptions({
        text: "## Done\n\n```ts\nconst x = 1;\n```\n\nAll `27` tests pass 🎉",
        engines: { say, elevenlabs: fakeEngine("elevenlabs") },
      }),
    );
    expect(result.spoken_text).toBe("Done. All 27 tests pass");
  });
});

describe("speak — the log records only what was heard", () => {
  test("nothing is logged before playback succeeds", async () => {
    let logExistedDuringPlayback = true;
    const say = fakeEngine("say", {
      onSpeak: () => {
        logExistedDuringPlayback = existsSync(spokenLogPathFor(home, new Date()));
      },
    });

    await speak(baseOptions({ engines: { say, elevenlabs: fakeEngine("elevenlabs") } }));
    expect(logExistedDuringPlayback).toBe(false);
  });

  test("a failed playback writes no line at all", async () => {
    const engines = {
      say: fakeEngine("say", { fail: true }),
      elevenlabs: fakeEngine("elevenlabs", { fail: true }),
    };
    await expect(speak(baseOptions({ engines }))).rejects.toThrow(CouldNotSpeakError);
    expect(existsSync(spokenLogPathFor(home, new Date()))).toBe(false);
  });
});

describe("speak — the ElevenLabs fallback is audible, never silent", () => {
  const elevenDefaults = { defaultVoice: "elevenlabs:abc123", text: "Ready." };

  test("falls back to say when ElevenLabs has no key", async () => {
    const say = fakeEngine("say");
    const warnings: string[] = [];
    const result = await speak(
      baseOptions({
        ...elevenDefaults,
        engines: { say, elevenlabs: fakeEngine("elevenlabs", { available: false }) },
        warn: (message) => warnings.push(message),
      }),
    );

    expect(result.engine).toBe("say");
    expect(say.spoken).toHaveLength(1);
    expect(warnings.join(" ")).toContain("say");
  });

  test("falls back to say when ElevenLabs fails mid-call", async () => {
    const say = fakeEngine("say");
    const result = await speak(
      baseOptions({
        ...elevenDefaults,
        engines: { say, elevenlabs: fakeEngine("elevenlabs", { fail: true }) },
      }),
    );
    expect(result.engine).toBe("say");
    expect(result.voice).toBe("system");
  });

  test("the fallback engine is what lands in the log, not the one that was asked for", async () => {
    const result = await speak(
      baseOptions({
        ...elevenDefaults,
        engines: {
          say: fakeEngine("say"),
          elevenlabs: fakeEngine("elevenlabs", { fail: true }),
        },
      }),
    );
    expect(readLog(result.log_path)[0]!.engine).toBe("say");
  });

  test("a say failure has nowhere left to fall — it is a hard failure", async () => {
    await expect(
      speak(
        baseOptions({
          engines: {
            say: fakeEngine("say", { fail: true }),
            elevenlabs: fakeEngine("elevenlabs"),
          },
        }),
      ),
    ).rejects.toThrow(CouldNotSpeakError);
  });
});

describe("speak — nothing speakable", () => {
  test("refuses text that cleans down to nothing, and logs nothing", async () => {
    await expect(
      speak(
        baseOptions({
          text: "```\njust code\n```",
          engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") },
        }),
      ),
    ).rejects.toThrow(NothingToSpeakError);
    expect(existsSync(spokenLogPathFor(home, new Date()))).toBe(false);
  });
});

describe("speak — the configured speed reaches the engine", () => {
  test("the tuning rides along to the engine that plays", async () => {
    const say = fakeEngine("say");
    await speak(
      baseOptions({ engines: { say, elevenlabs: fakeEngine("elevenlabs") }, speed: 1.1 }),
    );
    expect(say.tunings.map((t) => t?.speed)).toEqual([1.1]);
  });
});

describe("speak — the cap is loud, never silent", () => {
  test("overlong text is cut, spoken, flagged, and the warning says how much fell", async () => {
    const say = fakeEngine("say");
    const warnings: string[] = [];
    const result = await speak(
      baseOptions({
        text: "word ".repeat(2_000).trim(),
        engines: { say, elevenlabs: fakeEngine("elevenlabs") },
        warn: (message) => warnings.push(message),
      }),
    );

    expect(result.truncated).toBe(true);
    expect(result.spoken_text.endsWith("…")).toBe(true);
    expect(say.spoken).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("characters past");
    expect(warnings[0]).toContain("paragraph-sized");
  });

  test("the ledger records the capped text — what was heard, not what was sent", async () => {
    const say = fakeEngine("say");
    const result = await speak(
      baseOptions({
        text: "word ".repeat(2_000).trim(),
        engines: { say, elevenlabs: fakeEngine("elevenlabs") },
        warn: () => {},
      }),
    );
    const lines = readLog(result.log_path);
    expect(lines[0]!.text.endsWith("…")).toBe(true);
  });

  test("normal-length text reports truncated: false and warns about nothing", async () => {
    const warnings: string[] = [];
    const result = await speak(
      baseOptions({
        engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") },
        warn: (message) => warnings.push(message),
      }),
    );
    expect(result.truncated).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});

describe("speak — sentence chunking (M1)", () => {
  const THREE = "First point. Second point. Third point.";

  test("each sentence plays on its own and gets its own C2 line, in order", async () => {
    const say = fakeEngine("say");
    const result = await speak(
      baseOptions({
        text: THREE,
        answerId: "a-9",
        engines: { say, elevenlabs: fakeEngine("elevenlabs") },
      }),
    );

    expect(say.spoken.map((s) => s.text)).toEqual([
      "First point.",
      "Second point.",
      "Third point.",
    ]);
    const entries = readLog(result.log_path);
    expect(entries.map((e) => e!.text)).toEqual(["First point.", "Second point.", "Third point."]);
    expect(entries.every((e) => e!.session_id === "sess-1" && e!.answer_id === "a-9")).toBe(true);
    expect(result.spoken_text).toBe(THREE);
  });

  test("a sentence's ledger line lands before the next sentence starts playing", async () => {
    const linesAtPlayStart: number[] = [];
    const say = fakeEngine("say", {
      onSpeak: () => {
        const path = spokenLogPathFor(home, new Date());
        linesAtPlayStart.push(existsSync(path) ? readLog(path).length : 0);
      },
    });
    await speak(
      baseOptions({ text: THREE, engines: { say, elevenlabs: fakeEngine("elevenlabs") } }),
    );
    expect(linesAtPlayStart).toEqual([0, 1, 2]);
  });

  test("the ticket's remaining_text always starts at the sentence now playing", async () => {
    const lockDir = join(home, "state", "playback");
    const remainings: Array<string | undefined> = [];
    const say = fakeEngine("say", {
      onSpeak: () => {
        const tickets = readdirSync(lockDir).filter((n) => n.endsWith(".ticket"));
        remainings.push(
          parseTicketBody(readFileSync(join(lockDir, tickets[0]!), "utf8"))?.remaining_text,
        );
      },
    });
    await speak(
      baseOptions({ text: THREE, engines: { say, elevenlabs: fakeEngine("elevenlabs") } }),
    );
    expect(remainings).toEqual([
      "First point. Second point. Third point.",
      "Second point. Third point.",
      "Third point.",
    ]);
  });

  test("the next sentence is synthesised while the current one plays — prefetch, one ahead", async () => {
    const say = fakeEngine("say", { playDelayMs: 15 });
    await speak(
      baseOptions({ text: THREE, engines: { say, elevenlabs: fakeEngine("elevenlabs") } }),
    );
    const prepareSecond = say.events.indexOf("prepare:Second point.");
    const firstDone = say.events.indexOf("play-end:First point.");
    const prepareThird = say.events.indexOf("prepare:Third point.");
    const secondDone = say.events.indexOf("play-end:Second point.");
    expect(prepareSecond).toBeGreaterThan(-1);
    expect(prepareSecond).toBeLessThan(firstDone);
    expect(prepareThird).toBeLessThan(secondDone);
  });

  test("ElevenLabs gets the neighbours for stitching — spoken text behind, unspoken ahead", async () => {
    const eleven = fakeEngine("elevenlabs");
    await speak(
      baseOptions({
        text: THREE,
        defaultVoice: "elevenlabs:abc123",
        engines: { say: fakeEngine("say"), elevenlabs: eleven },
      }),
    );
    expect(eleven.tunings.map((t) => [t?.previousText, t?.nextText])).toEqual([
      [undefined, "Second point. Third point."],
      ["First point.", "Third point."],
      ["First point. Second point.", undefined],
    ]);
  });
});

describe("speak — the fallback is per answer, not per sentence (M1)", () => {
  test("the first ElevenLabs failure drops the rest of the answer to say", async () => {
    const eleven = fakeEngine("elevenlabs", { failOnCall: 2 });
    const say = fakeEngine("say");
    const warnings: string[] = [];
    const result = await speak(
      baseOptions({
        text: "First point. Second point. Third point.",
        defaultVoice: "elevenlabs:abc123",
        engines: { say, elevenlabs: eleven },
        warn: (message) => warnings.push(message),
      }),
    );

    expect(eleven.spoken.map((s) => s.text)).toEqual(["First point."]);
    expect(say.spoken.map((s) => s.text)).toEqual(["Second point.", "Third point."]);
    // No mid-answer flapping: sentence three never went back to ElevenLabs.
    expect(eleven.events).not.toContain("prepare:Third point.");
    expect(result.engine).toBe("say");

    const entries = readLog(result.log_path);
    expect(entries.map((e) => e!.engine)).toEqual(["elevenlabs", "say", "say"]);
    expect(warnings.join(" ")).toContain("falling back");
  });

  test("a playback failure falls back too, and the sentence is still spoken — audibly, never silently", async () => {
    const eleven = fakeEngine("elevenlabs", { failOnCall: 1, failAt: "play" });
    const say = fakeEngine("say");
    const result = await speak(
      baseOptions({
        text: "First point. Second point.",
        defaultVoice: "elevenlabs:abc123",
        engines: { say, elevenlabs: eleven },
        warn: () => {},
      }),
    );
    expect(say.spoken.map((s) => s.text)).toEqual(["First point.", "Second point."]);
    expect(readLog(result.log_path).map((e) => e!.engine)).toEqual(["say", "say"]);
  });

  test("sentences already spoken keep their ledger lines when say later hard-fails", async () => {
    const say = fakeEngine("say", { failOnCall: 2 });
    await expect(
      speak(
        baseOptions({
          text: "First point. Second point.",
          engines: { say, elevenlabs: fakeEngine("elevenlabs") },
        }),
      ),
    ).rejects.toThrow(CouldNotSpeakError);
    const entries = readLog(spokenLogPathFor(home, new Date()));
    expect(entries.map((e) => e!.text)).toEqual(["First point."]);
  });
});

describe("speak — the answer id rides the ticket, the ledger, and the result (C7)", () => {
  test("the held ticket carries session, answer, and the text still to speak", async () => {
    const lockDir = join(home, "state", "playback");
    let bodies: Array<ReturnType<typeof parseTicketBody>> = [];
    const say = fakeEngine("say", {
      onSpeak: () => {
        bodies = readdirSync(lockDir)
          .filter((name) => name.endsWith(".ticket"))
          .map((name) => parseTicketBody(readFileSync(join(lockDir, name), "utf8")));
      },
    });

    await speak(
      baseOptions({
        answerId: "a-77",
        engines: { say, elevenlabs: fakeEngine("elevenlabs") },
      }),
    );

    expect(bodies).toEqual([
      { session_id: "sess-1", answer_id: "a-77", remaining_text: "The build passed." },
    ]);
  });

  test("the C2 line and the --json payload name the answer", async () => {
    const result = await speak(
      baseOptions({
        answerId: "a-77",
        engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") },
      }),
    );
    expect(result.answer_id).toBe("a-77");
    expect(readLog(result.log_path)[0]!.answer_id).toBe("a-77");
  });

  test("no answer id means null everywhere — the chunk is the answer", async () => {
    const result = await speak(
      baseOptions({ engines: { say: fakeEngine("say"), elevenlabs: fakeEngine("elevenlabs") } }),
    );
    expect(result.answer_id).toBeNull();
    expect(readLog(result.log_path)[0]!.answer_id).toBeNull();
  });
});

describe("speak — serialisation", () => {
  test("playback happens while the lock is held, and the lock is released after", async () => {
    const lockDir = join(home, "state", "playback");
    let ticketsDuringPlayback = 0;
    const say = fakeEngine("say", {
      onSpeak: () => {
        ticketsDuringPlayback = readdirSync(lockDir).filter((n) => n.endsWith(".ticket")).length;
      },
    });

    await speak(baseOptions({ engines: { say, elevenlabs: fakeEngine("elevenlabs") } }));

    expect(ticketsDuringPlayback).toBe(1);
    expect(readdirSync(lockDir)).toHaveLength(0);
  });

  test("the lock is released even when playback fails", async () => {
    const lockDir = join(home, "state", "playback");
    await speak(
      baseOptions({
        engines: {
          say: fakeEngine("say", { fail: true }),
          elevenlabs: fakeEngine("elevenlabs", { fail: true }),
        },
      }),
    ).catch(() => {});
    expect(readdirSync(lockDir)).toHaveLength(0);
  });
});
