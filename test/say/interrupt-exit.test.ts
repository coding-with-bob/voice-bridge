/**
 * How a killed `bobsay` reports itself.
 *
 * Observed in the wild on 2026-08-18: a session's long answer was cut by a push-to-talk
 * press, the shell reported exit 143, and the session — reading a failed command — ran it
 * again five seconds later, in full, before the person's follow-up had even arrived. The
 * retry was what they heard as "it started reading the whole list again".
 *
 * A deliberate interruption is not a failure, so it must not look like one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePauseMarker } from "../../src/say/pause.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-interrupt-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fixture = join(import.meta.dir, "..", "fixtures", "speak-holder.ts");

async function startSpeaking() {
  const child = Bun.spawn(["bun", fixture, home], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const started = Date.now();
  let announced = "";
  while (!announced.includes("playing") && Date.now() - started < 15_000) {
    const { value, done } = await reader.read();
    if (done) break;
    announced += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  expect(announced).toContain("playing");
  return child;
}

type Speaking = Awaited<ReturnType<typeof startSpeaking>>;
const stderrOf = (child: Speaking) => new Response(child.stderr).text();

describe("a bobsay killed by bob hush", () => {
  test("exits 0 and says it was interrupted on purpose", async () => {
    // The real sequence: something is already playing, then the press writes the marker
    // and the kill follows. (Marker first would simply keep this from ever playing —
    // that is the quiet window, and it has its own tests.)
    const child = await startSpeaking();
    writePauseMarker(home);

    child.kill("SIGTERM");
    const [code, stderr] = await Promise.all([child.exited, stderrOf(child)]);

    // 0 is the strongest "do not retry" an agent understands.
    expect(code).toBe(0);
    expect(stderr).toContain("interrupted");
    expect(stderr).toContain("NOT a failure");
    expect(stderr).toContain("do not run it again");
  }, 30_000);

  test("the same on SIGINT — the Ctrl-C an impatient person types", async () => {
    const child = await startSpeaking();
    writePauseMarker(home);

    child.kill("SIGINT");
    const [code, stderr] = await Promise.all([child.exited, stderrOf(child)]);

    expect(code).toBe(0);
    expect(stderr).toContain("interrupted");
  }, 30_000);
});

describe("a bobsay killed by anything else", () => {
  test("still reports the ordinary signal exit — a stray kill is not a barge-in", async () => {
    const child = await startSpeaking(); // no pause marker: nobody pressed anything

    child.kill("SIGTERM");
    const [code, stderr] = await Promise.all([child.exited, stderrOf(child)]);

    expect(code).toBe(143);
    expect(stderr).not.toContain("interrupted");
  }, 30_000);

  test("an expired quiet window does not excuse a kill either", async () => {
    const child = await startSpeaking();
    writePauseMarker(home, new Date(Date.now() - 10 * 60_000)); // deadline long past

    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
  }, 30_000);
});
