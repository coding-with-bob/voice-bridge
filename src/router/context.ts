/**
 * Assembling what the router model gets to see.
 *
 * Three tiers, none of which we maintain by hand: pool metadata the server already keeps
 * (title, workspace, status, recency), the tail of the spoken ledger (a byproduct of
 * speaking, exactly router-prompt-sized), and — derived at read time, never stored — the
 * most recent interaction, which is the latest of "who last spoke" and "who was last
 * dispatched to". A pointer file would have been a cache that drifts; two event logs cannot.
 *
 * This module is pure: everything it needs arrives as arguments, so the routing rules are
 * testable against fixtures without a server, a model, or a clock.
 */
import type { PoolSession, SessionStatus } from "../omnigent/parse.ts";
import type { SpokenLogEntry } from "../contracts/spoken-log.ts";
import type { LedgerHit } from "./ledger.ts";
import type { DispatchEvent } from "./decision-log.ts";

/** How many spoken lines per session the model sees. Enough to recognise, short enough to scan. */
const SPOKEN_TAIL_LINES = 2;

/** A reach-back offers a shortlist, not the whole ledger. */
const MAX_LEDGER_MATCHES = 5;

export interface CandidateSession {
  id: string;
  title: string | null;
  workspace: string | null;
  status: SessionStatus;
  minutes_since_active: number;
  spoken_tail: string[];
}

/**
 * A session surfaced by a ledger reach-back. It is addressable but sits outside the
 * candidate window — the horizon-free path the window would otherwise cut off.
 */
export interface LedgerMatch extends CandidateSession {
  /** The spoken lines that matched the query, so the model can see why it surfaced. */
  matched_lines: string[];
}

/** A tier-3 transcript extract: the end of a candidate's conversation, not its opening. */
export interface PeekExtract {
  session_id: string;
  turns: Array<{ role: string; text: string }>;
}

export interface RecentInteraction {
  session_id: string;
  kind: "spoken" | "dispatch";
  minutes_ago: number;
  within_followup_window: boolean;
}

export interface RoutingContext {
  candidates: CandidateSession[];
  /** Added by a ledger reach-back round; empty until one happens. */
  ledger_matches: LedgerMatch[];
  /** Added by a tier-3 peek round; empty until one happens. */
  peeks: PeekExtract[];
  most_recent: RecentInteraction | null;
  /** Absolute root the project names hang off. Without it the model has to guess a prefix. */
  projects_root: string;
  /** Directory names under the root — the placement vocabulary, so the model cannot invent a path. */
  project_dirs: string[];
  home_dir: string;
  followup_window_min: number;
  candidate_window_days: number;
  /** One line describing what the model saw; goes into the decision log for later forensics. */
  digest: string;
}

export interface ContextInput {
  sessions: PoolSession[];
  spoken: SpokenLogEntry[];
  dispatches: DispatchEvent[];
  projectsRoot: string;
  projectDirs: string[];
  homeDir: string;
  followupWindowMin: number;
  candidateWindowDays: number;
  now: Date;
}

export function buildContext(input: ContextInput): RoutingContext {
  const nowSeconds = input.now.getTime() / 1000;
  const windowSeconds = input.candidateWindowDays * 86_400;
  const tails = spokenTails(input.spoken);

  const candidates = input.sessions
    .filter((session) => !session.archived && session.status !== "failed")
    .map((session) => ({ session, activeAt: session.updated_at ?? session.created_at }))
    .filter(({ activeAt }) => nowSeconds - activeAt <= windowSeconds)
    .sort((left, right) => right.activeAt - left.activeAt)
    .map(({ session, activeAt }) => ({
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      status: session.status,
      minutes_since_active: Math.max(0, Math.floor((nowSeconds - activeAt) / 60)),
      spoken_tail: tails.get(session.id) ?? [],
    }));

  const mostRecent = deriveMostRecent(input, new Set(candidates.map((c) => c.id)));

  return {
    candidates,
    ledger_matches: [],
    peeks: [],
    most_recent: mostRecent,
    projects_root: input.projectsRoot,
    project_dirs: input.projectDirs,
    home_dir: input.homeDir,
    followup_window_min: input.followupWindowMin,
    candidate_window_days: input.candidateWindowDays,
    digest: describeDigest(candidates, mostRecent),
  };
}

function spokenTails(entries: SpokenLogEntry[]): Map<string, string[]> {
  const tails = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.session_id === null) continue; // router acks belong to no session
    const lines = tails.get(entry.session_id) ?? [];
    lines.push(entry.text);
    tails.set(entry.session_id, lines.slice(-SPOKEN_TAIL_LINES));
  }
  return tails;
}

/**
 * The latest of the two event streams. A session that has since left the pool is dropped:
 * offering an unaddressable target would only invite a decision that cannot be executed.
 */
function deriveMostRecent(input: ContextInput, addressable: Set<string>): RecentInteraction | null {
  const events: Array<{ session_id: string; at: number; kind: "spoken" | "dispatch" }> = [];
  for (const entry of input.spoken) {
    if (entry.session_id === null) continue;
    events.push({ session_id: entry.session_id, at: Date.parse(entry.ts), kind: "spoken" });
  }
  for (const dispatch of input.dispatches) {
    events.push({ session_id: dispatch.session_id, at: Date.parse(dispatch.ts), kind: "dispatch" });
  }

  const latest = events
    .filter((event) => Number.isFinite(event.at) && addressable.has(event.session_id))
    .sort((left, right) => right.at - left.at)[0];
  if (latest === undefined) return null;

  const minutesAgo = Math.max(0, Math.floor((input.now.getTime() - latest.at) / 60_000));
  return {
    session_id: latest.session_id,
    kind: latest.kind,
    minutes_ago: minutesAgo,
    within_followup_window: minutesAgo <= input.followupWindowMin,
  };
}

function describeDigest(
  candidates: CandidateSession[],
  mostRecent: RecentInteraction | null,
): string {
  const recent =
    mostRecent === null
      ? "no recent interaction"
      : `most recent ${mostRecent.session_id} ${mostRecent.minutes_ago}m ago (${mostRecent.kind}` +
        `${mostRecent.within_followup_window ? ", in window" : ", out of window"})`;
  return `${candidates.length} candidates; ${recent}`;
}

/** Every session the model may legitimately address: the window plus any reach-back matches. */
export function addressableIds(context: RoutingContext): Set<string> {
  return new Set([
    ...context.candidates.map((candidate) => candidate.id),
    ...context.ledger_matches.map((match) => match.id),
  ]);
}

/**
 * Turn ledger hits into addressable candidates. Sessions the pool no longer knows about are
 * dropped: surfacing an unreachable target would only invite a decision that cannot execute.
 */
export function buildLedgerMatches(input: {
  hits: LedgerHit[];
  sessions: PoolSession[];
  alreadyOffered: Set<string>;
  now: Date;
}): LedgerMatch[] {
  const nowSeconds = input.now.getTime() / 1000;
  const bySession = new Map<string, { lines: string[]; score: number }>();
  for (const hit of input.hits) {
    const id = hit.entry.session_id;
    if (id === null || input.alreadyOffered.has(id)) continue;
    const existing = bySession.get(id) ?? { lines: [], score: 0 };
    existing.lines.push(hit.entry.text);
    existing.score = Math.max(existing.score, hit.score);
    bySession.set(id, { lines: existing.lines.slice(-SPOKEN_TAIL_LINES), score: existing.score });
  }

  const matches: Array<LedgerMatch & { score: number }> = [];
  for (const [id, matched] of bySession) {
    const session = input.sessions.find((candidate) => candidate.id === id);
    if (session === undefined || session.status === "failed") continue;
    const activeAt = session.updated_at ?? session.created_at;
    matches.push({
      id: session.id,
      title: session.title,
      workspace: session.workspace,
      status: session.status,
      minutes_since_active: Math.max(0, Math.floor((nowSeconds - activeAt) / 60)),
      spoken_tail: [],
      matched_lines: matched.lines,
      score: matched.score,
    });
  }

  // Best match first, recency breaking ties, and a hard cap: a reach-back is meant to put a
  // shortlist in front of the model, not to paste the ledger into the prompt.
  return matches
    .sort((left, right) =>
      right.score === left.score
        ? left.minutes_since_active - right.minutes_since_active
        : right.score - left.score,
    )
    .slice(0, MAX_LEDGER_MATCHES)
    .map(({ score: _score, ...match }) => match);
}
