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
- `--json` emits `{spoken_text, engine, voice, log_path}`.
- Side effects, in this order: play audio (serialized via a file lock) → **on successful playback**
  append the C2 log line. The log records only what was actually heard; a failed playback writes no line.
- **Sessionless calls** (no `--session`, e.g. router acks) log with `session_id: null`.
- Fallback from ElevenLabs to `say` is **audible, never silent**.

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

- `terminal_launch_args` carries `--permission-mode` / `--append-system-prompt`.
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
