# Hey Bob — the voice bridge

Push-to-talk voice entry into a pool of Claude Code sessions running on your own Mac. Hold a
hotkey, say a sentence, release: the request lands in the session that already holds the context
for it — or in a fresh one born in the right directory — and that session does the work with its
own tools and speaks the answer back.

It is not a cloud service and it has no daemon of its own. Two CLIs and a hotkey: `bob route`
decides, dispatches, acknowledges and exits; `bobsay` is what sessions call to speak. The session
pool underneath is [Omnigent](https://github.com/omnigent-ai/omnigent), adopted stock — we
orchestrate over it and never build into it.

**Two rules shape everything below.** The pool stays stock: Omnigent is configured and called
over HTTP, never patched, so an upgrade is a reinstall plus a `bob doctor` run rather than a
merge. And the bridge starts nothing that keeps running — the only long-lived processes are
Omnigent's own server and host daemon, and they are acceptable precisely because the server binds
loopback only, which is why `bob doctor` re-verifies the bind on every run instead of trusting
the config file that asked for it.

---

## Setup from zero

**Prerequisites:** macOS, [bun](https://bun.sh), Hammerspoon and ffmpeg (the push-to-talk entry),
and — for the typed fallback entry — Raycast with a dictation tool (Monologue). Everything else is
installed below.

### 1. Omnigent (the session pool)

```bash
uv tool install --python 3.12 omnigent
# or, for the exact build this was written against:
# uv tool install --python 3.12 git+https://github.com/omnigent-ai/omnigent.git
omnigent --version
```

Built and tested against **0.10.0.dev0 (`c4dd03c4`, built 2026-08-14)**. Upgrades are deliberate,
never automatic — reinstall, then re-run `bob doctor`, which is the thing that tells you whether
the platform still behaves the way the bridge assumes.

```bash
omnigent server --background     # binds 127.0.0.1:6767
omnigent host                    # the host daemon that launches terminals locally
```

Start terminal work with `omnigent claude` rather than `claude` when you want that session to
join the pool — voice reach-back can only see sessions the pool knows about.

### 2. The code

```bash
git clone https://github.com/coding-with-bob/voice-bridge.git ~/dev/voice-bridge
cd ~/dev/voice-bridge
bun install && bun link
```

`bun link` puts its shims in `~/.bun/bin`. If that directory is not on your PATH, put them
somewhere that is — `bobsay` has to be reachable from a bare environment and not just from your
interactive shell, because the thing that calls it is a spawned session:

```bash
ln -sf ~/.bun/bin/bob    ~/.local/bin/bob
ln -sf ~/.bun/bin/bobsay ~/.local/bin/bobsay
```

### 3. The state home

```bash
bob init
```

`~/bob` — or wherever `BOB_HOME` points — is the state home: configuration, the ledgers, and the
fallback workspace for requests that name no project. `bob init` builds it from nothing: the
`spoken/`, `logs/` and `state/` directories, a `CLAUDE.md` carrying the C6 speak-on-finish
convention, and a `defaults.yaml` in which every key is present, documented, and commented out —
so a fresh home behaves exactly like no config file at all and nothing in it can silently
disagree with the schema. It **never overwrites**: an existing file is reported and left exactly
as it is, which makes a second run a readable inventory of the home rather than a silent success.
Run it whenever you are unsure the home is complete.

The convention file is the reason the command exists. Without it a fresh clone routes perfectly
and never speaks back — the most confusing failure this thing has.

The state home is not part of this checkout and holds no code. Making it a git repo of its own is
a good idea; what to keep out of that repo is covered below.

**What to set first.** Everything in `defaults.yaml` is optional, but three things are worth a
minute:

- `owner_name` — the name sessions call you by. It travels in the spoken convention and in the
  metadata block that rides every routed request, so an answer is addressed to a person rather
  than to nobody. The default names nobody on purpose (`the owner`).
- `default_voice` — `say:Samantha` out of the box, a macOS system voice that needs no key at all
  (`say -v ?` lists what your machine has, including other languages). `elevenlabs:<voice-id>` is
  the upgrade, and [Voice](#4-voice-optional-but-the-point) is how to wire it.
- The four sentences the bridge speaks **for itself**, never through a session:
  `clarify_fallback_text`, `correction_undone_text`, `correction_blocked_text` and
  `correction_asleep_text`. They are ordinary config strings with plain-English defaults — set
  them to whatever language you actually talk to the machine in (mine are Hungarian).

**Where new sessions are born.** The placement vocabulary is simply the directory names under
`~/dev`: the router is shown the ones that exist, picks among them, and the choice is re-checked
against the filesystem before a session is created — so it cannot invent a plausible path. No
registry to maintain, and no `~/dev` at all is a valid state: then everything lands in the state
home.

Spawned sessions run on `session_model` / `session_effort` from `defaults.yaml` (`claude-opus-5`,
`high`), stated on every launch. Leaving them to Claude Code's own default would mean the model
you last picked for your own terminal silently becomes the model the voice bridge thinks with.

A single request can override the session model out loud — *"in pipeline, csináld Fable-lel:
listázd a docs mappa fájljait"*. No prefix or keyword convention: the router picks the model out
of ordinary speech, drops it from what the session is asked to do, and the ack says which model it
used, so a misread is audible within a second. The choices are `session_models`, offered to the
router as a list it may not add to and re-checked before the session is created. It applies to
**new sessions only** — Omnigent persists the launch args, so a session comes back on the model it
was born with, and asking for one alongside a continue is answered by the ack saying it stayed.

**Correcting a misroute.** If the ack names the wrong place, say so — *"nem, ez rossz volt, az
invoice exportos sessionbe"*. The router treats that as a correction rather than a follow-up,
identifies **which** request you mean against the recent exchanges — by content, or by position
when you count ("az előző", "a kettővel ezelőtti") — undoes what it can, and re-routes. A good
request that arrived between the mistake and the correction is untouched, and a correction the
router cannot pin to a specific exchange becomes a question, never a guess.

Withdrawing a request works the same way — *"erre már nincs szükségem, hagyd az előző
feladatot"* — and goes through the same undo machinery rather than being delivered as a polite
stop message. That distinction is not cosmetic: a busy session cannot stop its own turn by being
told, because the message queues behind the very work it means to stop. Stopping a running
dispatch is a platform act, and only the router can perform it.

One boundary is deliberate: **a request sent to an already-busy session can never be interrupted
later** — withdrawn only by note. A queued message merges into the running foreign turn at its
first tool boundary (measured: 3 s in, turn still running), so once it is out of the queue there
is no way to stop it without killing the work it hid inside. What makes the safe case provable
is a fact recorded at dispatch time: a message sent to an *idle* session started the turn now
running, and that turn — and only that — a correction may interrupt. What "undo" means depends on
what the mistake was: a session that exists only because of it is interrupted and deleted; a
message that has started running is interrupted; a message still queued behind unrelated work is
**not** interrupted, because that would cancel someone else's turn and let the mistake start next
anyway. In that last case the session is told to disregard the message — identified by its
content, never by "the previous one", which would be ambiguous the moment a legitimate request
arrived after the mistake — and the ack says it could not be pulled back. Deletion can only ever
reach a session the immediately preceding decision itself created (`correction_window_min`), and
only while nothing else has been dispatched to it since.

The question underneath all of it is mechanical: **has our own message started yet?** A dispatched
message comes back with a `pending_id`, and the session snapshot lists that id under
`pending_inputs` until it is consumed — still listed means still queued, gone means running or
already done. There is no dequeue endpoint anywhere in the pool, which is why the still-queued
case gets the honest answer instead of a destructive one.

**The state home is also a transcript of everything you have ever said to the machine, and
everything it has said back.** That is the point — reach-back reads it — and it is why the ledgers
are not in git: `logs/*.jsonl` and `spoken/*.jsonl` are gitignored, so the repo tracks only what a
person authors — `CLAUDE.md`, `defaults.yaml`, `.gitignore`. Git buys an append-only log nothing
anyway: the file already *is* the chronological record, and diff and blame are meaningless on
appended lines.

With the transcript out of it, the home repo is safe to give a remote — a private one, since what
remains is still yours. The ledgers, though, still need protecting, and the spoken log is what
reach-back reads, so they are backed up as *files* instead: a daily snapshot into iCloud Drive
with an age gate and a retention window, driven by Hammerspoon
([why not launchd](hammerspoon/README.md#the-daily-state-backup-heybob-backuplua--backup-bob-statesh)).

### 4. Voice (optional but the point)

The default voice is `say:Samantha`, a macOS system voice — no key, works immediately, and
`say -v ?` shows the rest of what your machine has, in every language it has. For ElevenLabs, put
the key in the environment as `ELEVENLABS_API_KEY` or in the Keychain (service
`ELEVENLABS_API_KEY`), pick a voice id, and set `default_voice: "elevenlabs:<id>"` in
`defaults.yaml`. `ELEVENLABS_MODEL_ID` overrides the model (default `eleven_flash_v2_5`), and
`elevenlabs_speed` in the same file adjusts the pace (0.7–1.2, default 1.0 — the voice's own).

The key is optional for speaking and required for listening. Without it, TTS falls back to macOS
`say` — audibly, in the other voice, never silently. But the push-to-talk entry transcribes with
ElevenLabs Scribe, so `bob dictate` needs the key, with the **speech_to_text** permission enabled
on it.

### 5. Entry

Two entries, one pipeline:

- **Push-to-talk (the everyday one):** [`hammerspoon/README.md`](hammerspoon/README.md) —
  hold Globe+Ctrl+Alt, speak, release. Hammerspoon records while the chord is held and hands
  the wav to `bob dictate`.
- **Typed / fallback:** [`raycast/README.md`](raycast/README.md) — the Raycast script command
  with Monologue dictation; add the script directory, assign a hotkey, done.

### 6. Check it

```bash
bob doctor
```

Ten checks, and a failure names the command that fixes it. **Run it after every Omnigent
upgrade**, not just when something feels wrong: it re-verifies the loopback bind (the condition
that makes a standing server acceptable in the first place), the host daemon, the C6 convention,
the router's real decision call, and a full create-message-answer round trip in a throwaway
session it deletes afterwards.

The last check, **repair**, covers the primitives a correction is built on: that a message comes
back with a `pending_id`, and that an interrupt stops a turn this check started itself. The first
is the one worth running for — without it a correction can never prove a running turn is its own,
so it takes the conservative branch every time and silently stops interrupting anything. An
upgrade could take that away and nothing else in the system would notice.

### 7. Optional: the nightly sweep

`bob gc` stops sessions idle beyond `gc_idle_hours` — stop only, never delete. Running it on a
schedule is documented and deliberately **not** installed for you; a background job that stops
sessions is something you switch on knowingly.

```bash
cp launchd/com.heybob.gc.plist ~/Library/LaunchAgents/
# then edit the copy: launchd expands no $HOME, so every /Users/YOURNAME/... path
# inside must become a real absolute path before it is loaded
launchctl load ~/Library/LaunchAgents/com.heybob.gc.plist
```

There are four of them: the `bob` shim (wherever `bun link` put it), the `PATH` the job runs with,
and the two log paths under your state home. The plist file
([`launchd/com.heybob.gc.plist`](launchd/com.heybob.gc.plist)) says the rest, including why it
fires at 04:37.

### 8. Optional: routing auth through a proxy (llmp)

**Skip this whole section if you sign in to Claude Code the ordinary way.** The router looks for
`llmp` on PATH and falls back to plain `claude` when there is none, which on a normal login is the
correct launcher — and `bob doctor`'s **router** check exercises the real decision call either
way, so a wrong guess here cannot fail silently.

Read on only if your subscription auth reaches Claude Code through a local proxy such as llmp.
Then the claude-native harness must be pointed at the wrapper in this repo, so every spawned
session is its own llmp launch rather than an heir to whatever token the pool server captured at
startup ([why](#known-platform-quirks)). Stock Omnigent, configuration only:

```yaml
# ~/.omnigent/config.yaml
harness:
  claude-native:
    command: /path/to/voice-bridge/omnigent/claude-llmp
```

The host daemon reads this at startup, so `omnigent host stop` + `omnigent host --background`
after changing it — and start it with `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` unset, so
there is no borrowed credential in it to go stale in the first place.

---

## The verbs

| Command | What it does |
|---|---|
| `bob init` | Create the state home — directories, the C6 convention file, a fully commented `defaults.yaml`. Idempotent and never overwrites; a second run is an inventory. `--home <dir>` for a home other than `$BOB_HOME`/`~/bob`, `--json`. |
| `bob route "<utterance>"` | Decide where the utterance goes, dispatch it, speak an acknowledgement, exit. `--dry-run` decides and logs without touching the pool or the speakers; `--json` for the full decision. |
| `bob dictate <audio-file>` | Transcribe a recording with ElevenLabs Scribe, then run the same route pipeline on the transcript — the PTT entry's second half. Silence routes nothing and exits 0. `--stt-only` prints the transcript without routing; `--dry-run` and `--json` as on `route`. Needs the `ELEVENLABS_API_KEY` with the **speech_to_text** permission enabled; `ELEVENLABS_STT_MODEL_ID` overrides the model (default `scribe_v2`). |
| `bob hush` | Barge-in: kill the answer that is playing (and the queued chunks of that same answer), write the interruption record, pause the queue. Audio only — never touches a session. PTT fires it before the recorder starts. `--json`. |
| `bob resume` | Lift the quiet window `bob hush` left standing — the PTT cancel path. `--json`. |
| `bob doctor` | The ten platform checks. `--quick` skips the spawn smoke test; `--json` for machines. Exit 1 on any failure, 2 on broken config. |
| `bob log` | The three logs as one timeline. `--reachbacks` for reach-backs only, `--spoken` / `--decisions` / `--gc` to narrow, `-n` for how many, `--json`. |
| `bob gc` | Stop sessions idle beyond `gc_idle_hours`. **Stop only — never delete.** `--dry-run` lists what it would touch. |
| `bobsay "<text>"` | Speak text and record what was heard in the ledger. One sentence for a status report; a content-length answer goes in one call when it fits (the cap is 5,000 chars, and a cut warns on stderr — never silent), split into as few chained calls as possible above that. `--session <id>` when a session is speaking, `--answer <id>` when chained calls form one answer, `--voice`, `--engine`, `--json`. |

Exit codes are uniform: **0** done, **1** could not do it, **2** the call or the setup was wrong.
A `bobsay` stopped by `bob hush` also exits **0** — an interruption is a decision, not a
failure — and says so on stderr, because a session that reads a failure runs the command again.

---

## The contracts (C1–C7)

The seams, pinned before the pieces were built. Full text in
[`src/contracts/README.md`](src/contracts/README.md); C2, C3, C5 and C7 are zod schemas in that
directory. **Changing one is a deliberate commit touching the contract and every consumer.**

| | Subject | The part that matters |
|---|---|---|
| **C1** | `bobsay` CLI | The ledger records only what was actually *heard*: the log line is written after playback succeeds, never before. The ElevenLabs fallback is audible — you still hear the sentence, in the other voice. |
| **C2** | spoken ledger | `~/bob/spoken/YYYY-MM-DD.jsonl`, append-only. **No pointer files**: "most recent interaction" is derived at read time from this log and the decision log. One source of truth, no cache to drift. |
| **C3** | `~/bob/defaults.yaml` | One loader, both CLIs, strict schema — a typo'd key is a hard error, not a silent default. |
| **C4** | Omnigent client | The only module that speaks HTTP. Readers degrade unknown values instead of throwing; a missing session id is the one fatal defect. |
| **C5** | router decision | A discriminated union, so a structurally valid but *unexecutable* decision is impossible. Executability (does the session exist, is the path a directory?) is checked separately, before any side effect. |
| **C6** | speak-on-finish | One canonical text in `~/bob/CLAUDE.md`, injected verbatim into every spawned session. A delimited block rides **every** routed message: it carries the session id, and — since only the router writes it — marks the request as *spoken*, which is what tells the session to answer out loud. The convention marks it transport metadata, never content. |
| **C7** | playback queue | The interruption record stores only the *unheard* side; the heard side is C2's job, and the two must not disagree. The sentence playing when a barge-in lands counts as unheard — better repeated than dropped. |

**The router addresses; it never interprets the domain.** It answers two questions — does a
pooled session already hold this context, and if not, where should a new one be born — and
leaves what the request *means* to the session that owns it.

---

## Acceptance run — 2026-08-15

All three design scenarios, live, through the Raycast script in a bare environment — the script leg, entered as text. The hotkey-and-dictation leg in front of it is the one part still unexercised, because it belongs to the owner.

| Step | Result | Time | Target |
|---|---|---|---|
| `bob doctor` | 8/8 green | 9.5 s | — |
| **S/A** new work → project placement → spoken result | new session in `~/dev/website`, spoke its answer | ack **7.4 s**, result +16 s | ack ≤ ~5 s |
| **S/B** follow-up with no self-contained meaning | continued the same session, which resolved "those" from its own context | **17.1 s** to speech | ≤ ~10 s |
| **S/C** content match to a gc-stopped session | revived and answered from full context | **28.6 s** to speech | ≤ ~10 s |
| Nonsense request | model-generated spoken question, pool untouched (8 → 8 sessions) | — | — |
| Routing regression table, `--live` | 6/6 vs `claude-opus-5`, prompt `2026-08-15.2` | 31 s | — |
| Unit + integration suite | 338 pass, 0 fail | 11 s | — |

**Where the time goes, and what to do about it.** The acknowledgement is ~7 s, not the ~5 s
target: roughly 4 s of routing decision, 2 s of actually speaking the sentence (playback is
awaited, so the ledger cannot claim something you never heard), and ~1 s of process start. The
S/B and S/C figures are dominated by the session's own turn — the tool call and its `bobsay` —
and S/C additionally relaunches a stopped process.

This is exactly the evidence the design deferred the model choice to: `router_model` starts at a
capable tier deliberately, and **downscaling is a decision to make on a week of decision-log
data**, not on one afternoon. If routing quality holds, a faster tier takes ~4 s out of every
acknowledgement.

Spike baselines for comparison: warm loop 2–3 s, fresh session ~3 s. Nothing here is worse than
2× a comparable baseline once the session's own work is separated from the bridge's.

---

## Reach-backs are a signal, not just a feature

`bob log --reachbacks` lists the utterances that went back to a session older than the routing
candidate window. A run of them to the same transcript means value is stranded there that should
have been produced into files instead — and that is a hardening trigger, not a compliment to the
router.

## Known platform quirks

The last two are llmp-specific and matter only if you route Claude Code auth through a proxy
(see [step 8](#8-optional-routing-auth-through-a-proxy-llmp)) — but the shape of the failure is
worth reading either way, because it is what a healthy-looking pool of dead sessions looks like.

- **`session.status` SSE payloads are inconsistently shaped** (data-wrapped vs flat) and a stray
  `response.completed` can appear at turn start. The client parses defensively; we do not consume
  SSE at all — the router exits after dispatching and the session speaks for itself.
- **Built-in agent ids are not stable across server restarts.** Sessions from before a restart
  reference an agent id `/v1/agents` no longer lists, so the router resolves the claude-native
  agent by harness at spawn time and never from a stored id.
- **`pending_elicitations_count` did not reflect a visibly pending approval card** (observed
  2026-08-14). Reported upstream; nothing of ours depends on it.
- **Inherited environment belongs to the launcher, not the machine.** Where Claude Code's
  subscription auth arrives through a local proxy, that proxy's environment is injected by
  whoever starts it. Plain `claude` is then authenticated in a terminal and *not logged in* under
  Raycast or launchd — which is precisely where the router runs. The router detects `llmp` on
  PATH and uses `llmp claude` when it is there; `bob doctor`'s **router** check exercises the
  real decision call, so this can never fail silently again.
- **An llmp launch token belongs to a *process*, and dies with it.** llmp revokes a token the
  moment the process it was minted for exits (audit reason `process_gone`). A long-lived daemon
  started from something short-lived — which the Omnigent server always is — therefore ends up
  holding a dead token and handing it to every session it spawns. Measured 2026-08-14: server up
  at 20:06:53, its token revoked at 20:09:35, and for two days after that every spawned session
  answered 401 while the pool looked perfectly healthy. Fixed by spawning through
  [`omnigent/claude-llmp`](omnigent/claude-llmp) so each session is its own llmp launch with its
  own token — which is also what makes llmp's per-session binding, and switching subscriptions
  behind running sessions, work at all. `bob doctor`'s **spawn** check is what catches a
  regression here.

## Deliberately not built

Approval routing over a chat channel (the MVP relies on the Omnigent desktop app), stop-hook
enforcement of C6 (only if silent finishes recur), an FTS index over transcripts (only if peeks
become frequent or slow — the decision log measures this), and Codex sessions (the router can
address them; the conventions are Claude-side). The PTT capture left this list on 2026-08-16 —
it is built, as Hammerspoon hold-to-talk + Scribe rather than the Whisper API
([`hammerspoon/README.md`](hammerspoon/README.md) says why).

## Development

```bash
bun test                                              # unit + live-server integration
bun run typecheck
BOB_ROUTING_LIVE=1 bun test test/router/routing-table.test.ts   # manual: routing vs the real model
```

The integration tests skip cleanly when Omnigent is down. The live routing table is **manual by
design** — run it at acceptance and after any prompt edit, never in CI; a row fails only if it
fails twice consecutively, because one unlucky sample from a non-deterministic model is not a
regression. When routing goes wrong in real use, the misroute becomes a new row in
`test/router/routing-table.ts` first, and the fix second.

## License

MIT — see [`LICENSE`](LICENSE).
