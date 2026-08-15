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
import type { SpeechEngine } from "../../src/say/engines/engine.ts";
import { spokenLogPathFor, parseSpokenLogLine } from "../../src/contracts/spoken-log.ts";

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

function fakeEngine(
  name: "say" | "elevenlabs",
  behaviour: { available?: boolean; fail?: boolean; onSpeak?: () => void } = {},
): SpeechEngine & { spoken: Spoken[] } {
  const spoken: Spoken[] = [];
  return {
    name,
    spoken,
    available: () => behaviour.available ?? true,
    async speak(text: string, voice: string) {
      behaviour.onSpeak?.();
      if (behaviour.fail) throw new Error(`${name} blew up`);
      spoken.push({ text, voice });
    },
  };
}

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

describe("speak — serialisation", () => {
  test("playback happens while the lock is held, and the lock is released after", async () => {
    const lockDir = join(home, "state", "playback");
    let ticketsDuringPlayback = 0;
    const say = fakeEngine("say", {
      onSpeak: () => {
        ticketsDuringPlayback = readdirSync(lockDir).length;
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
