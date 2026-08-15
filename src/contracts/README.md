# Interface contracts (C1–C6)

The six seams between the pieces of the voice bridge, pinned before the pieces are built so
each increment can be tested against the contract rather than against another piece's internals.
Authority: `~/dev/bob-jarvis/design/voice-bridge-implementation-plan.md` §2.

**Changing a contract is a deliberate commit** touching the contract module and every consumer —
never a silent drift.

| Contract | Subject | Where it lives |
|---|---|---|
| C1 | `bobsay` CLI surface | prose, below · implemented in `src/cli/bobsay.ts` |
| C2 | spoken log + recency derivation | [`spoken-log.ts`](./spoken-log.ts) |
| C3 | `~/bob/defaults.yaml` | [`config.ts`](./config.ts) · loader in `src/config/load.ts` |
| C4 | Omnigent pool client surface | prose, below · implemented in `src/omnigent/client.ts` (M2) |
| C5 | router decision JSON + decision log | [`decision.ts`](./decision.ts) |
| C6 | speak-on-finish convention | prose, below · canonical text in `~/bob/CLAUDE.md` |

---

## C1 — `bobsay` CLI contract

```
bobsay [--session <id>] [--voice <engine:voice>] [--engine elevenlabs|say] [--json] "<text>"
```

- **Exit 0** = spoken (or queued and then spoken). **Nonzero** = could not speak at all, after fallback.
  Sub-codes: `1` = playback failed even after the fallback; `2` = the call was rejected before any
  audio (bad voice reference, contradicting `--engine`, malformed config, nothing speakable left).
- `--json` emits `{spoken_text, engine, voice, log_path}`.
- Side effects, in this order: play audio (serialized via a file lock) → **on successful playback**
  append the C2 log line. The log records only what was actually heard; a failed playback writes no line.
- **Sessionless calls** (no `--session`, e.g. router acks) log with `session_id: null`.
- Fallback from ElevenLabs to `say` is **audible, never silent**: the sentence is still spoken, in
  the macOS voice, and the log names the engine that actually spoke.
- Two environment variables sit outside C3 on purpose, because they are secrets or platform
  detail rather than behaviour: `ELEVENLABS_API_KEY` (env, else Keychain service of the same name)
  and `ELEVENLABS_MODEL_ID` (defaults to `eleven_flash_v2_5`).

## C4 — pool client surface

The only module that talks to Omnigent (`src/omnigent/client.ts`):

```ts
listSessions()
createSession({workspace, permissionMode, appendSystemPrompt?}) → {id}
postMessage(id, text)
stopSession(id)
sessionItems(id)
health()
```

Three methods beyond the six C4 names, added deliberately in M2 and documented here rather than
smuggled in: `listAgents()` and `listHosts()` (`createSession` resolves the claude-native agent and
an online host through them; `bob doctor` reports on both), and `deleteSession()` — reserved for
doctor deleting the throwaway session it created itself, because a smoke-test session left in the
pool becomes a routing candidate forever. The invariant that matters is unchanged: **no HTTP call
lives outside this module.**

- `terminal_launch_args` carries `--permission-mode` / `--append-system-prompt`.
  **Verified live on 2026-08-15** (M2 risk probe): a marker planted via `--append-system-prompt`
  came back from the spawned session, so C6 uses this path and needs no first-message fallback.
- Parse `session.status` **defensively**: the payload is inconsistently data-wrapped vs flat, and a
  stray `response.completed` can appear at turn start.
- Auth: spawned sessions inherit the machine's standard chain — Claude Code authenticates to the
  local llmp proxy with an env key, the proxy uses subscription OAuth upstream. The "API Usage
  Billing" statusline is a cosmetic artifact of that path, not metered billing. **No env stripping.**

## C6 — speak-on-finish convention

One canonical text, stored at `~/bob/CLAUDE.md` and reused **verbatim** by the router when spawning
(injected via `--append-system-prompt`; sessions born in `~/bob` also pick it up from the CLAUDE.md).

The convention text is **generic** — it carries no concrete session id, because the id only exists
after `createSession` returns. The router therefore prefixes the first posted message with a
delimited metadata block:

```
[bob metadata — not part of the request: your session id is <id>]
```

The convention states that this block is transport metadata: never quote it, never treat it as
content — so a "write this request verbatim to a file" task does not capture it.
