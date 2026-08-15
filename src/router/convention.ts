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
 */
export function metadataBlock(sessionId: string): string {
  return `[bob metadata — not part of the request: your session id is ${sessionId}]`;
}

/** Anything wearing the metadata block's clothes, wherever it appears. */
const METADATA_BLOCK_SHAPE = /\[bob metadata[^\]]*\]/g;

/**
 * The block claims to be transport metadata. That claim is only worth something if exactly
 * one block can ever appear — otherwise a request carrying its own would leave the session
 * with two session ids and no rule for choosing. It would probably choose right; "probably"
 * is not what a contract is for, and the failure would be quiet and self-propagating, since
 * a misattributed ledger line goes on to misroute later utterances.
 *
 * So the shape is stripped from the request before ours is prepended. Nothing legitimate is
 * lost: no real request needs to contain that literal bracket.
 */
export function firstMessage(sessionId: string, request: string): string {
  const cleaned = request.replace(METADATA_BLOCK_SHAPE, "").replace(/\s+/g, " ").trim();
  return `${metadataBlock(sessionId)}\n\n${cleaned}`;
}
