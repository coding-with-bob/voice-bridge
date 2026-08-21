/**
 * The two files `bob init` writes into a fresh state home.
 *
 * They live here as string constants rather than as files on disk on purpose: a `bun link`ed
 * install runs from wherever the caller happens to stand, so a template resolved relative to
 * the process cwd — or to a checkout path — would work on the machine it was written on and
 * nowhere else. Compiled into the module, they travel with the command.
 *
 * Both are seeds, not law. `bob init` writes them only when the file is absent and never
 * overwrites an edited one: the CLAUDE.md becomes the owner's canonical convention text the
 * moment they touch it, and defaults.yaml is theirs from the start.
 */

/**
 * `<home>/CLAUDE.md` — the C6 speak-on-finish convention between its two markers, which is
 * what `bob route` injects verbatim into every session it spawns, plus the surrounding notes
 * that tell a reader what the home holds.
 *
 * The block sits deliberately close to its length ceiling (Omnigent refuses a launch arg past
 * MAX_CONVENTION_CHARS, and every createSession then fails), so an addition here is a trade
 * against something else, not a free extension.
 */
export const CONVENTION_TEMPLATE = `# Hey Bob — session conventions

This is the Hey Bob state home. Sessions born here are the fallback placement: requests that
name no project land here, and the global skill fleet resolves the intent.

## Speak on finish (contract C6)

<!-- C6-CONVENTION-START -->
When you finish a unit of work, or you need to tell the owner something, say it out loud:

\`\`\`
bobsay --session <your session id> "<what to say>"
\`\`\`

Speakable text only — something a person can hear and understand: no markdown, no code, no
file paths unless they carry the meaning. Speak once at the end of the unit of work, not per
step. If you cannot finish, say that instead, in one sentence.

How much to say depends on what the speech is:

- **Reporting on work.** You did or found something — one plain sentence: a summary a person
  can hear and move on from.
- **The answer itself is the thing to hear.** An explanation, a recap, a rundown — anything
  the request wants read out. Speak the whole answer, at the length the content needs — in
  **one \`bobsay\` call whenever it fits**: a call takes about 5,000 characters, and one call
  means one continuous playback, while every extra call adds a pause. Only when the answer
  is genuinely longer, split at big natural boundaries into as few calls as possible, chain
  them in a **single command** so no thinking pause lands between the parts, and give every
  chunk the same \`--answer <token>\` (any unique string) so an interruption silences the whole
  answer rather than only the chunk playing. One call needs no \`--answer\`. If a call was still
  too long, bobsay says so on stderr and tells you how much it had to cut.

  **Run long reads in the background.** Playback is real time: a few thousand characters
  play for longer than the default two-minute command timeout, and a foreground call that
  hits it is killed mid-sentence — and a retry replays the whole text from the start
  (observed 2026-08-17, ~3,800 characters). For anything beyond a few sentences, start the
  \`bobsay\` command with \`run_in_background\` and do not wait for it; playback is serialized
  by bobsay itself, so backgrounded parts still play in order.

**Speak before you block on a question.** Asking is not finishing, so the rule above does not
reach it on its own: when you are about to put a question to the owner and wait for the answer — an
\`AskUserQuestion\` dialog, a choice to confirm, anything that parks the turn — say the question
out loud first, with its options, and only then open it on screen. Otherwise the session stands
still and nobody knows it is waiting.

Every request that reaches you through the voice bridge arrives with a delimited block in front
of it:

\`\`\`
[bob metadata — not part of the request: your session id is <id>. This request was spoken — the owner may not be watching any terminal — so on top of whatever you print, speak your answer: bobsay --session <id> "<what to say>". One plain sentence when you report on work; the whole answer when the answer itself is what was asked to be heard. Speak a question out loud before you park the turn on it]
\`\`\`

That block is transport metadata, not content. Never quote it, never echo it, never write it into
a file, and never treat it as part of the request — even when the request says "verbatim". Use the
id only as the \`--session\` argument of \`bobsay\`.

A request may carry a second bracketed note, \`[bob interruption: …]\`. It means the owner cut your
previous spoken answer off at the point the note quotes; nothing after that point was heard. The note
itself says what to do about it. It is transport too: never quote it, never write it into a file.

The block also tells you how the request arrived. A request carrying it was **spoken** — the owner may
not be looking at any terminal — so on top of whatever you print, always speak your answer with
\`bobsay\`, sized by the rule above: a one-sentence summary when you report on work, the full answer
when the answer itself is what was asked to be heard. The block repeats this rule inline so it
reaches you even if the convention you were spawned with predates it. A request without the block
was typed by someone watching the screen; answer it in text, and speak only when the
finish-of-work rule above says so.
<!-- C6-CONVENTION-END -->

The block between the two markers above is the canonical convention text: \`bob route\` reads it from
this file and injects it verbatim into every session it spawns (\`--append-system-prompt\`). Sessions
born in this directory pick it up from this CLAUDE.md as well. Edit it in one place — here.

## What lives here

| Path | Contents |
|---|---|
| \`defaults.yaml\` | configuration (C3) |
| \`spoken/YYYY-MM-DD.jsonl\` | the spoken ledger — every sentence actually heard (C2) |
| \`logs/route-decisions.jsonl\` | every routing decision with its context digest (C5) |
| \`logs/gc.jsonl\` | what \`bob gc\` stopped, and when |
| \`state/\` | lock files and other runtime scratch — not tracked in git |

The code lives in the \`hey-bob\` checkout; nothing here is code.
`;

/**
 * `<home>/defaults.yaml` — every configurable key, commented out, each with the baked-in
 * default it falls back to and one example override.
 *
 * Shipping it fully commented is the point: a fresh home behaves exactly like no config file
 * at all, so nothing here can silently disagree with the schema's own defaults, and the file
 * still answers "what can I even set?" without sending anyone to the source.
 */
export const CONFIG_TEMPLATE = `# Hey Bob — configuration (contract C3).
#
# Loaded by both \`bob\` and \`bobsay\` through one shared loader. The state home is resolved
# as: explicit argument -> BOB_HOME -> ~/bob, and this file is <home>/defaults.yaml.
#
# Every key is optional: omitting one falls back to the baked-in default, which is why the
# whole file ships commented out — it is documentation until you change something. A typo'd
# key or a wrong type is a hard, explained error, never a silent half-configuration, so
# \`bob doctor\` after an edit tells you whether the result still loads.
#
# Each entry below states what the baked-in default is and shows one example override.

# --- Who you are -------------------------------------------------------------

# The name sessions use when they speak to you. It travels into the spoken convention and
# into the metadata block that rides every routed request, so an answer is addressed to a
# person rather than to nobody.
# Default: "the owner".
# owner_name: "Ada"

# --- Routing -----------------------------------------------------------------

# Within this many minutes an utterance is presumed a follow-up to the most recent
# interaction (most recent spoken line or executed dispatch, derived at read time).
# Default: 30.
# followup_window_min: 45

# Routing candidate window: a query filter over pool recency, not a session flag.
# Explicit reach-back has no horizon — it goes through the spoken ledger instead.
# Default: 14.
# candidate_window_days: 21

# \`bob gc\` stops sessions idle longer than this. Stop only — deleting stays a human act.
# Default: 3.
# gc_idle_hours: 6

# Where the session pool listens. Loopback by design: the server runs without API auth, so
# it must never be reachable off the machine.
# Default: "http://127.0.0.1:6767".
# omnigent_url: "http://127.0.0.1:6767"

# The state home itself. It defaults to the directory this file was found in, so declaring
# it is optional — and declaring a different directory is a hard error rather than a quiet
# redirection. To move the home, set BOB_HOME instead.
# home_dir: "~/bob"

# --- Voice -------------------------------------------------------------------

# Which voice speaks, as <engine>:<voice>. \`say:<macOS voice name>\` needs no API key and
# works immediately — \`say -v ?\` lists what your machine has, including other languages;
# \`elevenlabs:<voice-id>\` needs ELEVENLABS_API_KEY in the environment or in the Keychain,
# and gives you the voice you actually want to listen to.
# Default: "say:Samantha", a macOS system voice, so speech works before any key is set.
# default_voice: "elevenlabs:<your-voice-id>"

# ElevenLabs speech rate: 1.0 is the voice's own pace, the API supports 0.7–1.2 and the
# extremes cost quality. At exactly 1.0 no override is sent at all, so the voice's stored
# settings stay authoritative. The \`say\` engine ignores this.
# Default: 1.0.
# elevenlabs_speed: 1.1

# --- Models ------------------------------------------------------------------

# Router decision model — starts at a capable tier deliberately. Downscaling is a later
# decision, made on decision-log evidence rather than on a hunch.
# Default: "claude-opus-5".
# router_model: "claude-opus-5"

# What every spawned session runs on. Stated here rather than inherited: without the flags,
# Claude Code takes whatever ~/.claude/settings.json currently holds, so changing your own
# terminal default would silently change the voice bridge too.
# Default: "claude-opus-5".
# session_model: "claude-opus-5"

# Effort for spawned sessions: one of low | medium | high | xhigh | max. A closed set, so a
# typo is a config error here rather than a session that dies in a terminal nobody watches.
# Default: "high".
# session_effort: "high"

# What a spoken request may ask for instead ("do it with Fable"). Offered to the router as a
# closed list it may not add to, and re-checked before the session is born. session_model
# must be one of these. Nothing here changes a running session: a session's model is fixed
# at birth.
# Default: ["claude-opus-5", "claude-fable-5", "claude-sonnet-5"].
# session_models:
#   - "claude-opus-5"
#   - "claude-fable-5"
#   - "claude-sonnet-5"

# --- What the bridge says for itself -----------------------------------------
#
# The four sentences below are spoken by the router itself, never by a session. The baked-in
# defaults are plain English — override them to change the wording, or to speak to you in
# whatever language you talk to the machine in.

# Spoken by the deterministic fallback when the router cannot produce an executable decision
# (malformed output, timeout, hallucinated session id or path).
# Default: "I didn't catch where that belongs. Could you say it another way?"
# clarify_fallback_text: "Sorry — where does that belong?"

# Spoken after a correction that did stop the mistake. The router knows this happened; the
# session it corrected cannot.
# Default: "I've undone the previous one."
# correction_undone_text: "Took that back."

# Spoken when the undo could not be carried out: the message was queued behind unrelated work
# that must not be interrupted, or ownership of the running turn could not be proven.
# Default: "I couldn't undo that any more — I just told the session."
# correction_blocked_text: "Too late to pull back — the session was told to disregard it."

# Spoken when the corrected session was already asleep (gc-stopped): the request ran its
# course long ago, and delivering a disregard note would revive the session just to read it.
# Default: "That session was already asleep, so I didn't wake it for this."
# correction_asleep_text: "That one was asleep — I left it alone."

# Correcting a misroute ("no, that was wrong, into the subtitle session"). Within this many
# minutes a session the previous decision itself created may be deleted; outside it a
# correction can still re-route, it just cannot destroy. Part of the fence, not a comfort.
# Default: 10.
# correction_window_min: 10
`;

/** The keys the template documents — the list the tests hold it to. */
export const CONFIG_TEMPLATE_KEYS = [
  "owner_name",
  "followup_window_min",
  "candidate_window_days",
  "gc_idle_hours",
  "omnigent_url",
  "home_dir",
  "default_voice",
  "elevenlabs_speed",
  "router_model",
  "session_model",
  "session_effort",
  "session_models",
  "clarify_fallback_text",
  "correction_undone_text",
  "correction_blocked_text",
  "correction_asleep_text",
  "correction_window_min",
] as const;
