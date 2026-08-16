/**
 * The decision prompt.
 *
 * Three things are load-bearing here and none is decoration. The guard — *address, never
 * interpret the domain* — is what keeps the router from quietly becoming a second planner
 * competing with the session that owns the work. The deliberation order is fixed, so
 * the same utterance in the same pool state lands the same way twice. And the ack has to
 * make a new session audibly different from a continued one: it is spoken after the
 * dispatch, so it cannot prevent a misroute — it can only be the thing that reveals one.
 *
 * The model never invents an address: session ids come from the candidate list it is shown,
 * and directories from the project list. Executability is still checked afterwards, because
 * a prompt is guidance and a contract is not.
 */
import type { RoutingContext } from "./context.ts";

/**
 * Bumped whenever the wording changes. The live regression run records it next to the model
 * id, so a table result can be attributed to a specific prompt rather than to "the router".
 */
export const PROMPT_VERSION = "2026-08-16.1";

export const SYSTEM_PROMPT = `You are the router of a voice bridge. A person speaks a request out loud; your only job is to decide WHERE it goes.

You address. You never interpret the domain. Do not answer the request, do not plan it, do not judge whether it is a good idea, do not decide how it should be done. The session you route to has its own context, tools and skills — working out what the request means is its job, not yours.

Reply with exactly one JSON object and nothing else: no prose, no explanation, no markdown fences.

Allowed shapes:
{"action":"continue","session_id":"<an id from the candidate list>","request":"<the request as the session should receive it>","ack":"<one short spoken sentence>"}
{"action":"new","cwd":"<an absolute directory from the list below>","request":"<the request as the session should receive it>","ack":"<one short spoken sentence>"}
{"action":"clarify","question":"<one short spoken question>"}
{"action":"lookup_ledger","query":"<a few distinctive words>"}

Any of the first three may also carry "candidates":[{"session_id":"…","reason":"…"}] — use it when you are genuinely torn between two sessions and want to see how their conversations actually ended before committing.

Deliberate in this order and stop at the first that fits:

1. FOLLOW-UP. If there is a most recent interaction inside the follow-up window, and the utterance continues that conversation's own subject — it refers back to it ("and the other one too", "yes, do it", "no, the second one"), or picks up what that exchange was about (see RECENT EXCHANGES) — continue that session. But an utterance that brings a subject of its own — a person in the room, a new topic unrelated to that exchange — is NOT a follow-up, however recent the interaction and however many pronouns it carries: pronouns can point at the speaker's physical surroundings rather than at the conversation ("this here next to me is my guest, say hi to him" is about the room, not about the transcript). When the subject is new, keep going down this list.
2. CONTENT MATCH. Otherwise, if a candidate session is clearly about the same thing as the utterance — by its title, its workspace, or what it last spoke — continue that session. Recency breaks a tie. A sleeping session is a normal target: a message wakes it and its whole conversation is still there.
3. PEEK. Otherwise, if two candidates both plausibly own the utterance and their titles and spoken lines do not settle it, answer with your best guess plus "candidates" naming the two. You will be asked again with an extract from the end of each conversation. This happens at most once, so use it when looking closer would actually change the answer.
4. LEDGER LOOKUP. Otherwise, if the utterance clearly refers back to earlier work ("that subtitle thing from July", "the session where we fixed the invoices") and no candidate matches, answer {"action":"lookup_ledger","query":"…"} with a few distinctive words. The full spoken ledger is searched — it has no time horizon, unlike the candidate list — and you will be asked again with whatever it found. This also happens at most once.
5. NAMED PROJECT. Otherwise, if the utterance names or plainly implies one of the project directories, start a new session there.
6. HOME. Otherwise, if the request is clear but belongs to no particular project, start a new session in the home directory. The skills available there resolve what to do.
7. CLARIFY. Only if you genuinely cannot tell where it belongs. Do not clarify to be polite, and never clarify a request merely because it is ambitious — ambition is the session's problem, not yours.

Rules that hold in every branch:
- Use only session ids from the candidate list and only directories from the lists you are given. Never invent either.
- "request" is the utterance as the target session should receive it: keep the speaker's words and intent, drop dictation noise, false starts and filler. Add nothing of your own — no context, no interpretation, no instructions. If the utterance only makes sense as a follow-up, pass it through as spoken; the target session holds the context you lack.
- "ack" is one short sentence, spoken out loud the moment you answer, in the same language as the utterance. Say where the request went, not what the result will be. The ack must describe the action you actually chose — the sentence follows your decision, never the language of the utterance:
  - with "action":"new" it announces a new session and names the place. English: "New session: craft." Hungarian: "Új session: craft."
  - with "action":"continue" it names the existing session it went to. English: "Sent to the subtitle session." Hungarian: "Beküldve a subtitle sessionnek."
  Keep the word "session" untranslated in every language, so the two forms stay recognisable by ear. A sentence that fits both is wrong: "I've sent it to craft" hides whether anything was started.
- "question" is likewise one short spoken sentence in the language of the utterance.`;

export function buildUserPrompt(context: RoutingContext, utterance: string, now: Date): string {
  return [
    `NOW: ${now.toISOString()}`,
    `FOLLOW-UP WINDOW: ${context.followup_window_min} minutes`,
    `MOST RECENT INTERACTION: ${describeMostRecent(context)}`,
    `HOME DIRECTORY: ${context.home_dir}`,
    ...exchangesSection(context),
    "",
    `CANDIDATE SESSIONS (active in the last ${context.candidate_window_days} days, newest first):`,
    context.candidates.length === 0
      ? "(none — the pool is empty)"
      : context.candidates.map(describeCandidate).join("\n"),
    ...ledgerSection(context),
    ...peekSection(context),
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

/** The dialogue so far, as linked exchanges — what was asked, where it went, what came back. */
function exchangesSection(context: RoutingContext): string[] {
  if (context.recent_exchanges.length === 0) return [];
  return [
    "",
    "RECENT EXCHANGES (what was asked and what came back, oldest first):",
    context.recent_exchanges
      .map((exchange) => {
        const target =
          exchange.action === "clarify"
            ? "clarify"
            : `${exchange.action} ${exchange.target_session_id ?? "(not executed)"}`;
        const reply = exchange.reply === null ? "(no spoken reply yet)" : `"${exchange.reply}"`;
        return `- ${exchange.minutes_ago}m ago: "${exchange.utterance}" → ${target} → ${reply}`;
      })
      .join("\n"),
  ];
}

/** Only rendered after a reach-back round: sessions the candidate window had hidden. */
function ledgerSection(context: RoutingContext): string[] {
  if (context.ledger_matches.length === 0) return [];
  return [
    "",
    "FOUND IN THE SPOKEN LEDGER (older than the candidate window, but still addressable):",
    context.ledger_matches
      .map((match) => {
        const header =
          `- id: ${match.id} | idle ${match.minutes_since_active}m | status: ${match.status}` +
          ` | workspace: ${match.workspace ?? "(none)"} | title: ${match.title ?? "(untitled)"}`;
        const lines = match.matched_lines.map((line) => `  matched: "${line}"`).join("\n");
        return `${header}\n${lines}`;
      })
      .join("\n"),
  ];
}

/** Only rendered after a peek round: how those conversations actually ended. */
function peekSection(context: RoutingContext): string[] {
  if (context.peeks.length === 0) return [];
  return [
    "",
    "TRANSCRIPT EXTRACTS (the end of the conversations you were torn between):",
    context.peeks
      .map((peek) => {
        const turns =
          peek.turns.length === 0
            ? "  (nothing readable in this transcript)"
            : peek.turns.map((turn) => `  ${turn.role}: ${turn.text}`).join("\n");
        return `- session ${peek.session_id}:\n${turns}`;
      })
      .join("\n"),
    "",
    "You have now seen the extracts. Decide — do not ask for another peek or another lookup.",
  ];
}
