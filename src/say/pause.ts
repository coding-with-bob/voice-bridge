/**
 * The quiet window's marker (C7c).
 *
 * From the PTT press until the router's acknowledgement has been spoken, ordinary
 * playback must not start: the person is talking, and a queued answer from some other
 * session barging in on that would be the same rudeness in reverse. The marker is a
 * file, so it survives across the several short-lived processes involved, and it carries
 * a hard deadline because a crashed roundtrip must not mute the machine.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  parsePauseMarker,
  PAUSE_DEADLINE_MS,
  pauseMarkerPath,
  type PauseMarker,
} from "../contracts/playback.ts";

export function writePauseMarker(
  homeDir: string,
  now: Date = new Date(),
  deadlineMs: number = PAUSE_DEADLINE_MS,
): PauseMarker {
  const marker: PauseMarker = {
    ts: now.toISOString(),
    deadline: new Date(now.getTime() + deadlineMs).toISOString(),
  };
  const path = pauseMarkerPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker));
  return marker;
}

/** The standing marker, or null when there is none — or one nobody can read. */
export function readPauseMarker(homeDir: string): PauseMarker | null {
  try {
    return parsePauseMarker(readFileSync(pauseMarkerPath(homeDir), "utf8"));
  } catch {
    return null;
  }
}

/** Lift the pause. True when there was one to lift. */
export function clearPauseMarker(homeDir: string): boolean {
  try {
    unlinkSync(pauseMarkerPath(homeDir));
    return true;
  } catch {
    return false; // already gone
  }
}
