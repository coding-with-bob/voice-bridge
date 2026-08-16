# Entry: Hammerspoon push-to-talk (PTT v2)

The one-gesture voice entry: **hold Globe+Ctrl+Alt, speak, release.** Hammerspoon records
while the chord is held and hands the finished wav to `bob dictate`, which transcribes it with
ElevenLabs Scribe and runs the same route pipeline the Raycast entry uses. Esc while holding
cancels. A modifier chord on purpose: modifiers type nothing on their own, so the gesture can
never collide with an app shortcut, and releasing *any* one of the three keys ends the take.

This exists because the Raycast+Monologue entry is a four-step gesture, and because the two
alternatives fail for a specific reason: a Raycast extension cannot see a key release at all,
and silence auto-stop cuts exactly where a non-native speaker pauses to think. Under a held
key, pauses are free. (The full research is in bob-jarvis:
`design/voice-bridge-implementation-plan.md` §5.)

## Install

1. `brew install --cask hammerspoon` and `brew install ffmpeg` (both already present if this
   machine ran the setup once).
2. Symlink the module and require it:
   ```bash
   mkdir -p ~/.hammerspoon
   ln -sf ~/dev/hey-bob/hammerspoon/heybob-ptt.lua ~/.hammerspoon/heybob-ptt.lua
   grep -q hs.ipc ~/.hammerspoon/init.lua 2>/dev/null || echo 'require("hs.ipc")' >> ~/.hammerspoon/init.lua
   grep -q heybob-ptt ~/.hammerspoon/init.lua 2>/dev/null || echo 'require("heybob-ptt")' >> ~/.hammerspoon/init.lua
   ```
   `hs.ipc` is not part of the PTT — it opens the message port the `hs` CLI needs, so the
   config can be reloaded and inspected from the terminal (`hs -c "hs.reload()"`) instead of
   relaunching the app.
3. Launch Hammerspoon and grant the two permissions it asks for, both one-time:
   **Accessibility** (the event tap that sees the key) and **Microphone** (the ffmpeg it
   spawns records under Hammerspoon's identity). Enable *Launch Hammerspoon at login* in its
   preferences.
4. The ElevenLabs key in the Keychain must carry the **speech_to_text** permission — a scoped
   key minted for TTS alone gets a loud 401 naming exactly this. Fix it in the ElevenLabs
   dashboard (API Keys → edit → enable Speech to Text), no code change needed.

## The flow

**Hold → speak → release.** Nothing opens and nothing needs closing: a small on-screen alert
shows while the microphone is live, the router speaks its acknowledgement a few seconds after
release, and the session speaks its answer when the work is done. Thinking pauses mid-utterance
cost nothing — recording follows the chord, not the sound.

- **Esc while holding** cancels the recording; nothing is dispatched.
- **Releases under 0.25 s** are dropped as fat-fingers.
- **120 s cap** as runaway protection — a held key is not a stuck key; hitting the cap
  dispatches what was recorded rather than erroring.
- **A recorder that ignores its stop signal is force-killed after 2 s.** ffmpeg can block
  forever opening an input device that just went away (observed 2026-08-16), and while a
  recording is "live" the Esc tap swallows every Esc on the machine — so a stuck take must
  never outlive its stop by more than the grace period.
- The last recording is kept at `~/bob/state/ptt-last.wav` until the next press — it is the
  debug artifact when a transcription looks wrong (`bob dictate --stt-only` replays it).
- **A capture that produces no bytes for 2.5 s is declared dead on the spot** — alert,
  Basso, take cancelled — instead of letting the speaker finish a question into a dead
  microphone. ffmpeg writes with `-flush_packets 1`, so a live mic shows data on disk well
  inside a second (measured ~16 KiB at 0.5 s); an empty file at 2.5 s means no frames are
  coming. Observed 2026-08-16: AVCaptureSession running, CoreAudio IO started, and still
  zero frames reached ffmpeg — a one-off that 22 scripted repro takes could not reproduce.
- **Every take is logged** to `~/bob/logs/ptt.jsonl`: outcome (`dispatched` / `empty` /
  `dead-air` / `cancelled` / `too-short`), hold duration, wav size, ffmpeg exit code, and —
  for failures — the tail of ffmpeg's stderr. The log exists because the 2026-08-16 empty
  take left no evidence at all; the next one will name its cause.

## Configuration

Top of `heybob-ptt.lua`: `PTT_CHORD` (which modifiers make the gesture — valid names are
`fn` for the Globe key, `ctrl`, `alt`, `cmd`, `shift`), `MAX_SECONDS`, `MIN_SECONDS`. The
recording device is the system default input (`:default`), so switching microphones needs no
config here. After any edit: Hammerspoon menu → *Reload Config*.

One system-side note: the Globe key's *solo* action (emoji picker / input-source switch) is
untouched by the chord, but if a slow chord press ever triggers it, set the key to
*Do Nothing* under System Settings → Keyboard → "Press 🌐 key to".

## When it goes wrong

Same contract as the Raycast entry: success is silent (you heard the acknowledgement), silence
is a non-event, and a failure raises a macOS notification with the reason — a 401 names the
key permission, "no audio" names the microphone grant, a routing error is `bob doctor`'s
department. `bob log` shows the decision that was (or was not) made.

## The environment trap, again

Hammerspoon launches tasks with a minimal environment, exactly like Raycast and launchd — the
launcher owns the environment, not the machine. So `heybob-ptt.lua` uses absolute paths only,
and `heybob-ptt.sh` exports the same explicit PATH as `raycast/heybob.sh`, for the same
reasons documented there (including `llmp claude` and `/usr/sbin` for `lsof`).
