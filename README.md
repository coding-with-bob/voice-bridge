# Hey Bob — the voice bridge

Push-to-talk voice entry into the ecosystem. A hotkey, a dictated sentence, and the request
lands in the session that already holds the context for it — or in a fresh one born in the right
directory. The session does the work with its own tools and speaks the answer back.

Two CLIs and no daemon of our own. `bob route` decides, dispatches, acknowledges and exits;
`bobsay` is what sessions call to speak. The session pool underneath is
Omnigent, adopted stock — we orchestrate over it and
never build into it.

**Governance:** design [`voice-bridge-one-pager.md`](../bob-jarvis/design/voice-bridge-one-pager.md) ·
platform [`omnigent-integration-contract.md`](../bob-jarvis/design/omnigent-integration-contract.md) ·
build [`voice-bridge-implementation-plan.md`](../bob-jarvis/design/voice-bridge-implementation-plan.md) ·
decision D10, rules R-8 (adopted components stay stock) and R-15 (standing-process exemption).

---

## Setup from zero

**Prerequisites:** macOS, bun, Raycast, and a dictation tool
(Monologue). Everything else is installed below.

### 1. Omnigent (the session pool)

Pinned working version: **0.10.0.dev0 (`c4dd03c4`, built 2026-08-14)**. Upgrades are deliberate,
never automatic — pull the checkout, `uv tool install`, then re-run `bob doctor`.

```bash
omnigent server --background     # binds 127.0.0.1:6767
omnigent host                    # the host daemon that launches terminals locally
```

Start terminal work with `omnigent claude` rather than `claude` when you want that session to
join the pool — voice reach-back can only see sessions the pool knows about.

### 2. The code and the state home

```bash
cd ~/dev/hey-bob && bun install && bun link
ln -sf ~/.bun/bin/bob    ~/.local/bin/bob        # bun link's shims are not on this machine's PATH
ln -sf ~/.bun/bin/bobsay ~/.local/bin/bobsay
```

`~/bob` is the state home: `defaults.yaml`, the ledgers, and the fallback workspace. It is its
own git repo and holds no code.

**It is also a transcript of everything you have ever said to the machine, and everything it has
said back.** That is the point — reach-back reads it — but it means the repo has no business
acquiring a remote without a deliberate decision. It has none today.

### 3. Voice (optional but the point)

The default voice is `say:Tünde`, the macOS Hungarian system voice — no key, works immediately.
For ElevenLabs, put the key in the environment or the Keychain (service `ELEVENLABS_API_KEY`),
pick a voice id, and set `default_voice: "elevenlabs:<id>"` in `~/bob/defaults.yaml`.
`ELEVENLABS_MODEL_ID` overrides the model (default `eleven_flash_v2_5`).

### 4. Entry

See [`raycast/README.md`](raycast/README.md): add the script directory, assign a hotkey, done.

### 5. Check it

```bash
bob doctor
```

Eight checks, and a failure names the command that fixes it. **This is the mandatory
post-upgrade check** the platform contract requires — run it after every Omnigent upgrade, not
just when something feels wrong. It re-verifies the loopback bind (the R-15 condition), the host
daemon, the C6 convention, the router's real decision call, and a full create-message-answer
round trip in a throwaway session it deletes afterwards.

---

## The verbs

| Command | What it does |
|---|---|
| `bob route "<utterance>"` | Decide where the utterance goes, dispatch it, speak an acknowledgement, exit. `--dry-run` decides and logs without touching the pool or the speakers; `--json` for the full decision. |
| `bob doctor` | The eight platform checks. `--quick` skips the spawn smoke test; `--json` for machines. Exit 1 on any failure, 2 on broken config. |
| `bob log` | The three logs as one timeline. `--reachbacks` for reach-backs only, `--spoken` / `--decisions` / `--gc` to narrow, `-n` for how many, `--json`. |
| `bob gc` | Stop sessions idle beyond `gc_idle_hours`. **Stop only — never delete.** `--dry-run` lists what it would touch. |
| `bobsay "<sentence>"` | Speak one sentence and record it in the ledger. `--session <id>` when a session is speaking, `--voice`, `--engine`, `--json`. |

Exit codes are uniform: **0** done, **1** could not do it, **2** the call or the setup was wrong.

---

## The contracts (C1–C6)

The seams, pinned before the pieces were built. Full text in
[`src/contracts/README.md`](src/contracts/README.md); C2, C3 and C5 are zod schemas in that
directory. **Changing one is a deliberate commit touching the contract and every consumer.**

| | Subject | The part that matters |
|---|---|---|
| **C1** | `bobsay` CLI | The ledger records only what was actually *heard*: the log line is written after playback succeeds, never before. The ElevenLabs fallback is audible — you still hear the sentence, in the other voice. |
| **C2** | spoken ledger | `~/bob/spoken/YYYY-MM-DD.jsonl`, append-only. **No pointer files**: "most recent interaction" is derived at read time from this log and the decision log. One source of truth, no cache to drift. |
| **C3** | `~/bob/defaults.yaml` | One loader, both CLIs, strict schema — a typo'd key is a hard error, not a silent default. |
| **C4** | Omnigent client | The only module that speaks HTTP. Readers degrade unknown values instead of throwing; a missing session id is the one fatal defect. |
| **C5** | router decision | A discriminated union, so a structurally valid but *unexecutable* decision is impossible. Executability (does the session exist, is the path a directory?) is checked separately, before any side effect. |
| **C6** | speak-on-finish | One canonical text in `~/bob/CLAUDE.md`, injected verbatim into every spawned session. A delimited block rides **every** routed message: it carries the session id, and — since only the router writes it — marks the request as *spoken*, which is what tells the session to answer out loud. The convention marks it transport metadata, never content. |

**The router addresses; it never interprets the domain.** It answers two questions — does a
pooled session already hold this context, and if not, where should a new one be born — and
leaves what the request *means* to the session that owns it.

---

## Acceptance run — 2026-08-15

All three design scenarios, live, through the Raycast script in a bare environment — the script leg, entered as text. The hotkey-and-dictation leg in front of it is the one part still unexercised, because it belongs to the owner.

| Step | Result | Time | Target |
|---|---|---|---|
| `bob doctor` | 8/8 green | 9.5 s | — |
| **S/A** new work → project placement → spoken result | new session in `~/dev/craft`, spoke its answer | ack **7.4 s**, result +16 s | ack ≤ ~5 s |
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

## Phase 1.5 exit criterion — usage-week tracker

> **Exit:** one week of real use — voice requests routed daily, spoken log alive, at least one
> voice return to an older or sleeping session.

| | Day | Routed | Reach-back? | Notes |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |

`bob log --reachbacks` answers the middle column. Reach-backs are a signal, not just a feature:
a run of them to the same transcript means value is stranded there that should have been produced
into files (D9), and that is a hardening trigger.

---

## Known platform quirks

- **`session.status` SSE payloads are inconsistently shaped** (data-wrapped vs flat) and a stray
  `response.completed` can appear at turn start. The client parses defensively; we do not consume
  SSE at all — the router exits after dispatching and the session speaks for itself.
- **Built-in agent ids are not stable across server restarts.** Sessions from before a restart
  reference an agent id `/v1/agents` no longer lists, so the router resolves the claude-native
  agent by harness at spawn time and never from a stored id.
- **Inherited environment belongs to the launcher, not the machine.** Claude Code's subscription
  auth arrives through the local llmp proxy, whose environment is injected by whoever starts it.
  Plain `claude` is therefore authenticated in a terminal and *not logged in* under Raycast or
  launchd. The router detects and uses `llmp claude`; `bob doctor`'s **router** check exercises
  the real decision call so this can never fail silently again.
- **`pending_elicitations_count` did not reflect a visibly pending approval card** (observed
  2026-08-14). Reported upstream; nothing of ours depends on it.

## Deliberately not built

Approval routing over Telegram (arrives with CHANNEL — MVP relies on the Omnigent desktop app),
stop-hook enforcement of C6 (only if silent finishes recur), an FTS index over transcripts (only
if peeks become frequent or slow — the decision log measures this), Whisper-API capture (only
when Raycast + Monologue chafes), and Codex sessions (the router can address them; the
conventions are Claude-side).

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
