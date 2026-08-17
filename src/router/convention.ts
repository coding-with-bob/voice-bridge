/**
 * C6 — the speak-on-finish convention.
 *
 * One canonical text, stored in `~/bob/CLAUDE.md` between markers and injected verbatim
 * into every spawned session. Reading it from the file rather than embedding it in the
 * binary is what makes "edit it in one place" true: sessions born in the home directory
 * pick up the same words from the same CLAUDE.md.
 *
 * A missing or empty convention is a hard error, never a silent default. Without it the
 * bridge still routes but nothing ever speaks back — the most confusing failure available.
 */
import { existsSync, readFileSync } from "node:fs";

const START_MARKER = "<!-- C6-CONVENTION-START -->";
const END_MARKER = "<!-- C6-CONVENTION-END -->";

export class ConventionError extends Error {
  override name = "ConventionError";
}

export function readConvention(conventionFile: string): string {
  if (!existsSync(conventionFile)) {
    throw new ConventionError(
      `The speak-on-finish convention file is missing: ${conventionFile}. ` +
        `Without it spawned sessions never speak back.`,
    );
  }

  const contents = readFileSync(conventionFile, "utf8");
  const start = contents.indexOf(START_MARKER);
  const end = contents.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new ConventionError(
      `${conventionFile} has no ${START_MARKER} … ${END_MARKER} block. ` +
        `That block is the C6 convention injected into every spawned session.`,
    );
  }

  const convention = contents.slice(start + START_MARKER.length, end).trim();
  if (convention === "") {
    throw new ConventionError(`The C6 convention block in ${conventionFile} is empty.`);
  }
  return convention;
}

/**
 * The session id cannot travel in the convention text — it does not exist until the session
 * is created. It rides the first message instead, in a delimited block the convention tells
 * the session to treat as transport metadata and never as content.
 *
 * The speak rule rides in the block too, not only in the spawn-time convention. Launch args
 * freeze the convention at spawn and revival replays the frozen copy, so a long-lived session
 * never learns a later amendment — the first silent finish (2026-08-16) was exactly that: a
 * session whose frozen text predated "block means spoken, answer out loud". The block reaches
 * every session on every routed message, so the rule travels where the convention cannot.
 * The question rule (2026-08-17) rides along for the same reason, and earns the length the
 * same way: a session that parks on a question nobody heard is stopped until someone thinks
 * to look at a terminal.
 * Invariant: no `]` before the closing bracket — the strip regex cuts at the first one.
 */
export function metadataBlock(sessionId: string): string {
  return (
    `[bob metadata — not part of the request: your session id is ${sessionId}. ` +
    `This request was spoken — Felho may not be watching any terminal — so on top of ` +
    `whatever you print, speak your answer: bobsay --session ${sessionId} "<what to say>". ` +
    `One plain sentence when you report on work; the whole answer when the answer itself ` +
    `is what was asked to be heard. Speak a question out loud before you park the turn on it]`
  );
}

/** Anything wearing the metadata block's clothes, wherever it appears. */
const METADATA_BLOCK_SHAPE = /\[bob metadata[^\]]*\]/g;

/**
 * The block rides EVERY message the router delivers, not just the first. It does two jobs:
 * it carries the session id (repeated, so a long conversation never loses it), and — since
 * only the router ever writes it — it marks the request as having arrived by voice, which
 * is what tells the session to speak its answer rather than assume someone is watching a
 * terminal. A typed message never carries the block; that is the whole signal.
 *
 * Exactly one block may ever appear: a request carrying its own would leave the session
 * with two session ids and no rule for choosing, and a wrong --session writes a
 * misattributed ledger line that goes on to misroute later utterances. So the shape is
 * stripped from the request before ours is prepended. Nothing legitimate is lost: no real
 * request needs to contain that literal bracket.
 */
export function routedMessage(sessionId: string, request: string): string {
  const cleaned = request.replace(METADATA_BLOCK_SHAPE, "").replace(/\s+/g, " ").trim();
  return `${metadataBlock(sessionId)}\n\n${cleaned}`;
}
