/**
 * The routing regression table — the durable artifact of M4.
 *
 * Each row is a whole world: a pool state, a spoken ledger, an utterance, and the **full**
 * set of invariants the outcome must satisfy — not merely which action came back, but which
 * session or directory it landed on and which flags were raised. An assertion that only
 * checks the action passes for all the wrong reasons.
 *
 * The table runs two ways. Against a **mocked** model it exercises the orchestration: the
 * re-ask rounds, the executability gate, the flags, the fallback. Against the **real** model
 * (`BOB_ROUTING_LIVE=1`) it exercises the routing itself — whether the prompt, as written,
 * actually makes a capable model choose the right target.
 *
 * When routing goes wrong in real use, the fix starts here: the misroute becomes a new row
 * first, the change second.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { route, type RouteDeps, type RouteResult } from "../../src/router/route.ts";
import { claudeCliCall } from "../../src/router/model.ts";
import { pathsFor } from "../../src/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";
import type { PoolSession } from "../../src/omnigent/parse.ts";
import type { SpokenLogEntry } from "../../src/contracts/spoken-log.ts";
import type { DecisionLogEntry } from "../../src/contracts/decision.ts";
import type { CreateSessionOptions } from "../../src/omnigent/client.ts";

/** Real directories, so a placement decision survives the executability check. */
export const PROJECT_DIRS = ["craft", "confpipeline", "hey-bob"];
export const PROJECTS_ROOT = join(homedir(), "dev");

export interface RoutingExpectation {
  action: "continue" | "new" | "clarify" | "undo";
  session_id?: string;
  /** Compared after `~`/root expansion, so rows stay readable. */
  cwd?: string;
  reachback?: boolean;
  /** The model the session is actually born on — config default when the row expects none. */
  model?: string;
  /** Words the request must not still carry: naming a model is not part of the work. */
  requestExcludes?: string[];
  /** The decision-log ts of the dispatch the correction must resolve to. */
  corrects?: string;
}

export interface RoutingCase {
  name: string;
  sessions: PoolSession[];
  spoken?: SpokenLogEntry[];
  /** Prior dispatches, so a row can be about correcting one of them. */
  decisions?: DecisionLogEntry[];
  utterance: string;
  /** Scripted model answers for mocked mode, consumed one per round. */
  scripted: unknown[];
  expect: RoutingExpectation;
  /** Flags asserted only in mocked mode, where the round structure is deterministic. */
  mockExpect?: { peeked?: boolean; fallback?: boolean };
  /** Rows exercising machinery a real model cannot be asked to produce on demand. */
  mockOnly?: boolean;
}

const NOW = new Date("2026-08-15T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const minutesAgo = (minutes: number) => nowSeconds - minutes * 60;
const daysAgo = (days: number) => nowSeconds - days * 86_400;

function session(overrides: Partial<PoolSession> & { id: string }): PoolSession {
  return {
    title: null,
    workspace: null,
    status: "idle",
    agent_name: "claude-native-ui",
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
    archived: false,
    host_id: "h1",
    pending_elicitations: 0,
    ...overrides,
  };
}

function spoke(session_id: string, text: string, at: number): SpokenLogEntry {
  return {
    ts: new Date(at * 1000).toISOString(),
    session_id,
    text,
    voice: "Tünde",
    engine: "say",
  };
}

const subtitleSession = session({
  id: "sess-subtitles",
  title: "subtitle timing pass",
  workspace: join(PROJECTS_ROOT, "craft"),
  updated_at: minutesAgo(4),
});

const invoiceSession = session({
  id: "sess-invoices",
  title: "invoice export",
  workspace: join(PROJECTS_ROOT, "confpipeline"),
  updated_at: daysAgo(3),
});

export const ROUTING_TABLE: RoutingCase[] = [
  {
    name: "follow-up continues the most recent interaction",
    sessions: [subtitleSession, invoiceSession],
    spoken: [spoke("sess-subtitles", "The subtitle timing is fixed.", minutesAgo(4))],
    utterance: "and do the other one too",
    scripted: [
      { action: "continue", session_id: "sess-subtitles", request: "and do the other one too", ack: "ok" },
    ],
    expect: { action: "continue", session_id: "sess-subtitles" },
  },
  {
    // Regression (2026-08-15, first real use): went to the torrent session under the old
    // follow-up wording — deixis to the room read as deixis to the conversation. The old
    // prompt misrouted 3/3 in replay; an unconstrained model 0/3.
    name: "deixis to the room is not a follow-up — a new subject goes home",
    sessions: [
      session({
        id: "sess-tv",
        title: "sorozat letöltés",
        workspace: join(PROJECTS_ROOT, "tvtime-migration"),
        updated_at: minutesAgo(2),
      }),
    ],
    spoken: [spoke("sess-tv", "A Star Trek rész letöltése kész, magyar szinkronnal.", minutesAgo(2))],
    utterance: "Ez az itt mellettem a vendégem. Neki köszönj!",
    scripted: [
      {
        action: "new",
        cwd: "HOME_DIR",
        request: "Köszönj a mellettem álló vendégemnek!",
        ack: "Köszönök neki.",
      },
    ],
    expect: { action: "new", cwd: "HOME_DIR" },
  },
  {
    name: "content match wakes a sleeping session over a fresher unrelated one",
    sessions: [
      session({ id: "sess-fresh", title: "calendar tidy-up", updated_at: minutesAgo(2) }),
      session({
        id: "sess-invoices",
        title: "invoice export",
        workspace: join(PROJECTS_ROOT, "confpipeline"),
        updated_at: daysAgo(6),
      }),
    ],
    spoken: [
      spoke("sess-fresh", "Calendar is tidy.", minutesAgo(2)),
      spoke("sess-invoices", "The invoice export finished.", daysAgo(6)),
    ],
    utterance: "did the invoice export include the November numbers?",
    scripted: [
      { action: "continue", session_id: "sess-invoices", request: "did the invoice export include the November numbers?", ack: "ok" },
    ],
    expect: { action: "continue", session_id: "sess-invoices" },
  },
  {
    name: "a named project starts a session in that directory",
    sessions: [],
    utterance: "in confpipeline, list the documents in the docs folder",
    scripted: [
      { action: "new", cwd: join(PROJECTS_ROOT, "confpipeline"), request: "list the documents in the docs folder", ack: "ok" },
    ],
    expect: { action: "new", cwd: join(PROJECTS_ROOT, "confpipeline") },
  },
  {
    // Free speech, no prefix convention: the model is named mid-sentence like any other
    // aside, and the ack is what catches a misread. The naming must not survive into the
    // request — the session is told what to do, never what to run on.
    name: "a model named in the utterance is honoured and stripped from the request",
    sessions: [],
    utterance: "in confpipeline, csináld Fable-lel: listázd a docs mappa fájljait",
    scripted: [
      {
        action: "new",
        cwd: join(PROJECTS_ROOT, "confpipeline"),
        request: "listázd a docs mappa fájljait",
        ack: "Új session Fable-lel: confpipeline.",
        model: "claude-fable-5",
      },
    ],
    expect: {
      action: "new",
      cwd: join(PROJECTS_ROOT, "confpipeline"),
      model: "claude-fable-5",
      requestExcludes: ["Fable", "fable"],
    },
  },
  {
    // A correction has the *form* of a follow-up and the opposite meaning. Untreated, the fix
    // is delivered to the session that received the mistake — which is why CORRECTION is the
    // first thing the recipe considers, ahead of FOLLOW-UP.
    name: "a correction is not a follow-up — it goes where the mistake should have gone",
    sessions: [subtitleSession, invoiceSession],
    spoken: [spoke("sess-subtitles", "The subtitle timing is fixed.", minutesAgo(3))],
    decisions: [
      {
        ts: new Date(minutesAgo(2) * 1000).toISOString(),
        utterance: "did the invoice export include the November numbers?",
        context_digest: "2 candidates",
        decision: {
          action: "continue",
          session_id: "sess-subtitles",
          request: "did the invoice export include the November numbers?",
          ack: "Beküldve a subtitle sessionnek.",
        },
        latency_ms: 1200,
        model: "claude-opus-5",
        target_session_id: "sess-subtitles",
        executed: true,
        pending_id: "pending_mistake",
        reachback: false,
        peeked: false,
        fallback: false,
      },
    ],
    utterance: "nem, ez rossz volt, ez az invoice exportos sessionbe tartozott",
    scripted: [
      {
        action: "continue",
        session_id: "sess-invoices",
        request: "did the invoice export include the November numbers?",
        ack: "Beküldve az invoice export sessionnek.",
        corrects: "x1",
      },
    ],
    // The assertion is on the durable identity — the ts of the seeded mistake — not on
    // whatever per-invocation id the model used to name it.
    expect: {
      action: "continue",
      session_id: "sess-invoices",
      corrects: new Date(minutesAgo(2) * 1000).toISOString(),
    },
  },
  {
    // The case the semantic identification exists for: a good request arrived BETWEEN the
    // mistake and the correction. Positional "last dispatch" would undo the good one; the
    // correction names the older exchange instead, and the newer dispatch is untouched.
    name: "a correction reaches past a newer good dispatch to the exchange it names",
    sessions: [subtitleSession, invoiceSession],
    spoken: [spoke("sess-subtitles", "The subtitle timing is fixed.", minutesAgo(6))],
    decisions: [
      {
        ts: new Date(minutesAgo(5) * 1000).toISOString(),
        utterance: "did the invoice export include the November numbers?",
        context_digest: "2 candidates",
        decision: {
          action: "continue",
          session_id: "sess-subtitles",
          request: "did the invoice export include the November numbers?",
          ack: "Beküldve a subtitle sessionnek.",
        },
        latency_ms: 1200,
        model: "claude-opus-5",
        target_session_id: "sess-subtitles",
        executed: true,
        pending_id: "pending_mistake",
        reachback: false,
        peeked: false,
        fallback: false,
      },
      {
        ts: new Date(minutesAgo(2) * 1000).toISOString(),
        utterance: "shift the subtitles by two seconds",
        context_digest: "2 candidates",
        decision: {
          action: "continue",
          session_id: "sess-subtitles",
          request: "shift the subtitles by two seconds",
          ack: "Beküldve a subtitle sessionnek.",
        },
        latency_ms: 1100,
        model: "claude-opus-5",
        target_session_id: "sess-subtitles",
        executed: true,
        pending_id: "pending_good",
        reachback: false,
        peeked: false,
        fallback: false,
      },
    ],
    utterance:
      "nem, az invoice exportos kérdést rossz helyre küldted, az az invoice export sessionbe tartozott",
    scripted: [
      {
        action: "continue",
        session_id: "sess-invoices",
        request: "did the invoice export include the November numbers?",
        ack: "Beküldve az invoice export sessionnek.",
        corrects: "x1",
      },
    ],
    expect: {
      action: "continue",
      session_id: "sess-invoices",
      corrects: new Date(minutesAgo(5) * 1000).toISOString(),
    },
  },
  {
    // Regression (2026-08-17, first microphone trial): this utterance — verbatim, Scribe's
    // mishearing included — was routed as a follow-up and delivered as a polite "stop"
    // message that queued behind the very task it meant to stop. The recipe only knew
    // wrong-address corrections; a *withdrawal* ("I no longer need it") claims no wrong
    // address, so it fell through. The person had to claim a misroute that never happened
    // to get the interrupt. Withdrawal is now correction vocabulary.
    name: "a withdrawal is a correction, not a message to the session it would stop",
    sessions: [
      session({
        id: "sess-youtube",
        title: "YouTube összefoglaló",
        status: "running",
        updated_at: minutesAgo(1),
      }),
    ],
    decisions: [
      {
        ts: new Date(minutesAgo(1) * 1000).toISOString(),
        utterance: "Van a vágólapon egy YouTube link. Olvasd ki, és készíts összefoglalót",
        context_digest: "1 candidate",
        decision: {
          action: "new",
          cwd: "HOME_DIR",
          request: "Olvasd ki a vágólapról a YouTube linket, és készíts róla összefoglalót",
          ack: "Új session: home.",
        },
        latency_ms: 1300,
        model: "claude-opus-5",
        target_session_id: "sess-youtube",
        executed: true,
        pending_id: "pending_youtube",
        reachback: false,
        peeked: false,
        fallback: false,
      },
    ],
    utterance: "Megjöttem, hogy erre még nincs szükségem. Hagyd az előző feladatot",
    scripted: [{ action: "undo", corrects: "x1", ack: "Rendben." }],
    expect: { action: "undo", corrects: new Date(minutesAgo(1) * 1000).toISOString() },
  },
  {
    // The same guard every other address gets: an exchange id nobody offered never reaches
    // the repair. mockOnly — a real model cannot be asked to hallucinate on demand.
    name: "a correction naming an exchange nobody offered becomes a spoken question",
    sessions: [subtitleSession],
    spoken: [spoke("sess-subtitles", "The subtitle timing is fixed.", minutesAgo(3))],
    decisions: [
      {
        ts: new Date(minutesAgo(2) * 1000).toISOString(),
        utterance: "fix the timing",
        context_digest: "1 candidate",
        decision: {
          action: "continue",
          session_id: "sess-subtitles",
          request: "fix the timing",
          ack: "ok",
        },
        latency_ms: 1000,
        model: "claude-opus-5",
        target_session_id: "sess-subtitles",
        executed: true,
        reachback: false,
        peeked: false,
        fallback: false,
      },
    ],
    utterance: "nem, ez rossz volt",
    scripted: [
      {
        action: "undo",
        corrects: "x9",
        ack: "Visszavonom.",
      },
    ],
    expect: { action: "clarify" },
    mockExpect: { fallback: true },
    mockOnly: true,
  },
  {
    name: "a request belonging to no project is born at home",
    sessions: [],
    utterance: "what is on my calendar for tomorrow?",
    scripted: [
      { action: "new", cwd: "HOME_DIR", request: "what is on my calendar for tomorrow?", ack: "ok" },
    ],
    expect: { action: "new", cwd: "HOME_DIR" },
  },
  {
    name: "an utterance that addresses nothing gets a spoken question",
    sessions: [subtitleSession],
    spoken: [spoke("sess-subtitles", "The subtitle timing is fixed.", daysAgo(2))],
    utterance: "do the thing with the stuff from before",
    scripted: [{ action: "clarify", question: "Melyikre gondolsz?" }],
    expect: { action: "clarify" },
  },
  {
    name: "a ledger reach-back reaches a session the window had hidden",
    sessions: [
      session({ id: "sess-fresh", title: "calendar tidy-up", updated_at: minutesAgo(5) }),
      session({
        id: "sess-july",
        title: "conference badge printing",
        workspace: join(PROJECTS_ROOT, "craft"),
        updated_at: daysAgo(38),
        created_at: daysAgo(39),
      }),
    ],
    spoken: [
      spoke("sess-fresh", "Calendar is tidy.", minutesAgo(5)),
      spoke("sess-july", "The conference badge printing is sorted, four hundred badges.", daysAgo(38)),
    ],
    utterance: "back in July we sorted the conference badge printing — how many badges was it?",
    scripted: [
      { action: "lookup_ledger", query: "badge printing" },
      { action: "continue", session_id: "sess-july", request: "how many badges was it?", ack: "ok" },
    ],
    expect: { action: "continue", session_id: "sess-july", reachback: true },
  },
  {
    name: "being torn buys exactly one peek, then a decision",
    sessions: [
      session({ id: "sess-a", title: "subtitle timing", updated_at: minutesAgo(30) }),
      session({ id: "sess-b", title: "subtitle styling", updated_at: minutesAgo(20) }),
    ],
    utterance: "the subtitle one — is it finished?",
    scripted: [
      {
        action: "continue",
        session_id: "sess-a",
        request: "is it finished?",
        ack: "ok",
        candidates: [
          { session_id: "sess-a", reason: "timing" },
          { session_id: "sess-b", reason: "styling" },
        ],
      },
      { action: "continue", session_id: "sess-b", request: "is it finished?", ack: "ok" },
    ],
    expect: { action: "continue", session_id: "sess-b" },
    mockExpect: { peeked: true },
    mockOnly: true,
  },
  {
    name: "a hallucinated session id never reaches the pool",
    sessions: [subtitleSession],
    utterance: "carry on with that",
    scripted: [{ action: "continue", session_id: "conv_does_not_exist", request: "carry on", ack: "ok" }],
    expect: { action: "clarify" },
    mockExpect: { fallback: true },
    mockOnly: true,
  },
  {
    name: "a placement path that does not exist never creates a session",
    sessions: [],
    utterance: "in the imaginary project, do something",
    scripted: [
      { action: "new", cwd: join(PROJECTS_ROOT, "no-such-project-anywhere"), request: "do something", ack: "ok" },
    ],
    expect: { action: "clarify" },
    mockExpect: { fallback: true },
    mockOnly: true,
  },
  {
    name: "output that is not JSON becomes a spoken question, not a crash",
    sessions: [subtitleSession],
    utterance: "carry on with that",
    scripted: ["I think you probably mean the subtitles?"],
    expect: { action: "clarify" },
    mockExpect: { fallback: true },
    mockOnly: true,
  },
];

export interface RunOutcome {
  result: RouteResult;
  created: CreateSessionOptions[];
  messages: Array<{ id: string; text: string }>;
  /** The throwaway state home this row ran in; `HOME_DIR` expectations resolve to it. */
  homeDir: string;
}

/** Runs one row in a throwaway state home, so rows cannot see each other's logs. */
export async function runCase(
  testCase: RoutingCase,
  options: { live: boolean },
): Promise<RunOutcome> {
  const home = mkdtempSync(join(tmpdir(), "bob-table-"));
  try {
    seedLedger(home, testCase.spoken ?? []);
    seedDecisions(home, testCase.decisions ?? []);

    const created: CreateSessionOptions[] = [];
    const messages: Array<{ id: string; text: string }> = [];
    let round = 0;

    const deps: RouteDeps = {
      client: {
        listSessions: async () => testCase.sessions,
        postMessage: async (id: string, text: string) => {
          messages.push({ id, text });
          return { pendingId: null };
        },
        createSession: async (createOptions: CreateSessionOptions) => {
          created.push(createOptions);
          return { id: "conv_created" };
        },
        // The peek reads a transcript; rows describe sessions through their spoken lines,
        // so the extract is built from those rather than a second fixture format.
        sessionItems: async (id: string) =>
          (testCase.spoken ?? [])
            .filter((entry) => entry.session_id === id)
            .map((entry, index) => ({
              id: `${id}-${index}`,
              role: "assistant",
              text: entry.text,
              created_at: index,
            })),
        interrupt: async () => {},
        deleteSession: async () => {},
        sessionState: async () => ({ status: "idle" as const, pending_inputs: [], runner_online: true }),
      },
      config: { ...DEFAULT_CONFIG, home_dir: home },
      paths: pathsFor(home),
      modelCall: options.live
        ? claudeCliCall
        : async () => {
            const answer = testCase.scripted[Math.min(round, testCase.scripted.length - 1)];
            round += 1;
            const raw = typeof answer === "string" ? answer : JSON.stringify(answer);
            // Rows say HOME_DIR; only the run knows where that is.
            return { raw: raw.replaceAll("HOME_DIR", home), latencyMs: 10 };
          },
      conventionText: "speak on finish",
      projectsRoot: PROJECTS_ROOT,
      projectDirs: PROJECT_DIRS,
      speak: async () => {},
      now: () => NOW,
      lockOptions: { pollMs: 5 },
    };

    return { result: await route(testCase.utterance, deps), created, messages, homeDir: home };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** `HOME_DIR` in a row's expectation stands for the throwaway home of that run. */
export function resolveExpectedCwd(expected: string, homeDir: string): string {
  return expected === "HOME_DIR" ? homeDir : expected;
}

/** The decision log lives at one path; a row that seeds none leaves the file absent. */
function seedDecisions(home: string, entries: DecisionLogEntry[]): void {
  if (entries.length === 0) return;
  const path = pathsFor(home).decisionLog;
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function seedLedger(home: string, entries: SpokenLogEntry[]): void {
  mkdirSync(join(home, "spoken"), { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const entry of entries) {
    const day = entry.ts.slice(0, 10);
    const lines = byDay.get(day) ?? [];
    lines.push(JSON.stringify(entry));
    byDay.set(day, lines);
  }
  for (const [day, lines] of byDay) {
    writeFileSync(join(home, "spoken", `${day}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
}
