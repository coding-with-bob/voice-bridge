/**
 * The decision prompt.
 *
 * Two things are load-bearing here and neither is decoration. The guard — *address, never
 * interpret the domain* — is what keeps the router from quietly becoming a second planner
 * competing with the session that owns the work. And the deliberation order is fixed, so
 * the same utterance in the same pool state lands the same way twice.
 *
 * The model never invents an address: session ids come from the candidate list it is shown,
 * and directories from the project list. Executability is still checked afterwards, because
 * a prompt is guidance and a contract is not.
 */
import type { RoutingContext } from "./context.ts";

export const SYSTEM_PROMPT = `You are the router of a voice bridge. A person speaks a request out loud; your only job is to decide WHERE it goes.

You address. You never interpret the domain. Do not answer the request, do not plan it, do not judge whether it is a good idea, do not decide how it should be done. The session you route to has its own context, tools and skills — working out what the request means is its job, not yours.

Reply with exactly one JSON object and nothing else: no prose, no explanation, no markdown fences.

Allowed shapes:
{"action":"continue","session_id":"<an id from the candidate list>","request":"<the request as the session should receive it>","ack":"<one short spoken sentence>"}
{"action":"new","cwd":"<an absolute directory from the list below>","request":"<the request as the session should receive it>","ack":"<one short spoken sentence>"}
{"action":"clarify","question":"<one short spoken question>"}

Deliberate in this order and stop at the first that fits:

1. FOLLOW-UP. If there is a most recent interaction inside the follow-up window, and the utterance does not stand on its own — it refers back ("and the other one too", "yes, do it", "no, the second one"), or continues obviously from what that session just said — continue that session.
2. CONTENT MATCH. Otherwise, if a candidate session is clearly about the same thing as the utterance — by its title, its workspace, or what it last spoke — continue that session. Recency breaks a tie. A sleeping session is a normal target: a message wakes it and its whole conversation is still there.
3. NAMED PROJECT. Otherwise, if the utterance names or plainly implies one of the project directories, start a new session there.
4. HOME. Otherwise, if the request is clear but belongs to no particular project, start a new session in the home directory. The skills available there resolve what to do.
5. CLARIFY. Only if you genuinely cannot tell where it belongs. Do not clarify to be polite, and never clarify a request merely because it is ambitious — ambition is the session's problem, not yours.

Rules that hold in every branch:
- Use only session ids from the candidate list and only directories from the lists you are given. Never invent either.
- "request" is the utterance as the target session should receive it: keep the speaker's words and intent, drop dictation noise, false starts and filler. Add nothing of your own — no context, no interpretation, no instructions. If the utterance only makes sense as a follow-up, pass it through as spoken; the target session holds the context you lack.
- "ack" is one short sentence, spoken out loud the moment you answer, in the same language as the utterance. Say where the request went, not what the result will be.
- "question" is likewise one short spoken sentence in the language of the utterance.`;

export function buildUserPrompt(context: RoutingContext, utterance: string, now: Date): string {
  return [
    `NOW: ${now.toISOString()}`,
    `FOLLOW-UP WINDOW: ${context.followup_window_min} minutes`,
    `MOST RECENT INTERACTION: ${describeMostRecent(context)}`,
    `HOME DIRECTORY: ${context.home_dir}`,
    "",
    `CANDIDATE SESSIONS (active in the last ${context.candidate_window_days} days, newest first):`,
    context.candidates.length === 0
      ? "(none — the pool is empty)"
      : context.candidates.map(describeCandidate).join("\n"),
    "",
    `PROJECT DIRECTORIES — the absolute path of each is ${context.projects_root}/<name>,`,
    `so a new session in "craft" means cwd ${context.projects_root}/craft:`,
    context.project_dirs.length === 0
      ? "(none)"
      : context.project_dirs.map((name) => `- ${name}`).join("\n"),
    "",
    "UTTERANCE:",
    utterance,
  ].join("\n");
}

function describeMostRecent(context: RoutingContext): string {
  const recent = context.most_recent;
  if (recent === null) return "none";
  const window = recent.within_followup_window
    ? "INSIDE the follow-up window"
    : "outside the follow-up window";
  const kind = recent.kind === "spoken" ? "it spoke last" : "it was messaged last";
  return `session ${recent.session_id}, ${recent.minutes_ago} minutes ago (${kind}), ${window}`;
}

function describeCandidate(candidate: {
  id: string;
  title: string | null;
  workspace: string | null;
  status: string;
  minutes_since_active: number;
  spoken_tail: string[];
}): string {
  const header =
    `- id: ${candidate.id} | idle ${candidate.minutes_since_active}m | status: ${candidate.status}` +
    ` | workspace: ${candidate.workspace ?? "(none)"} | title: ${candidate.title ?? "(untitled)"}`;
  const tail =
    candidate.spoken_tail.length === 0
      ? "  (has not spoken)"
      : candidate.spoken_tail.map((line) => `  spoke: "${line}"`).join("\n");
  return `${header}\n${tail}`;
}
