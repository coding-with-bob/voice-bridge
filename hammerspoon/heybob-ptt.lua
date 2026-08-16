-- Hey Bob — push-to-talk entry (PTT v2).
--
-- Hold the PTT_CHORD modifiers together: recording starts. Release any of them:
-- recording stops and the utterance is dispatched through `bob dictate` (Scribe STT
-- → router → spoken acknowledgement). Esc while holding cancels. Pauses cost
-- nothing — the recording runs as long as the chord is held, which is the whole
-- reason this exists instead of silence detection.
--
-- This module is only the ear and the finger; everything downstream is the hey-bob
-- chain. The launcher owns the environment (the M5 lesson), so every path here is
-- absolute and the dispatch script exports its own PATH exactly like the Raycast entry.

-- The PTT gesture is a modifier chord: hold all of these together to record, release
-- any one of them to dispatch. Modifiers type nothing on their own, so the chord can
-- never collide with an app shortcut the way a regular key could. Valid names are the
-- ones hs.eventtap.event:getFlags() reports: fn (the Globe key), ctrl, alt, cmd, shift.
local PTT_CHORD = { fn = true, ctrl = true, alt = true }
local MAX_SECONDS = 120 -- runaway protection: a held chord is not a stuck one
local MIN_SECONDS = 0.25 -- below this it was a fat-finger, not an utterance
local KILL_GRACE = 2 -- seconds a recorder may outlive its SIGINT before SIGKILL
local DEAD_AIR_SECONDS = 2.5 -- with -flush_packets 1 data hits disk within ~1.5s of a live mic

local HOME = os.getenv("HOME")
local FFMPEG = "/opt/homebrew/bin/ffmpeg"
local DISPATCH = HOME .. "/dev/hey-bob/hammerspoon/heybob-ptt.sh"
local WAV = HOME .. "/bob/state/ptt-last.wav" -- kept until the next press: it is the debug artifact
local PTT_LOG = HOME .. "/bob/logs/ptt.jsonl"

local recorder = nil
local cancelled = false
local deadAir = false -- the dead-air check tripped: the cancel is a failure, not a choice
local startedAt = 0
local alertId = nil
local watchdog = nil
local deadAirTimer = nil
local killTimer = nil -- module-local on purpose: a timer held only by a closure gets GC'd

local function notify(text)
  -- Basso on purpose: the 2026-08-16 empty-take incident was reported as "nothing
  -- happened" — a silent banner is invisible to someone waiting for a spoken reply.
  hs.notify.new({ title = "Hey Bob", informativeText = text, soundName = "Basso" }):send()
end

-- One JSON line per take. This log exists because the empty-take failure left zero
-- evidence: ffmpeg's stderr and exit code were discarded, so the only artifact was
-- a 0-byte wav. Never let a failed take be silent in the log again.
local function logTake(fields)
  fields.ts = os.date("!%Y-%m-%dT%H:%M:%SZ")
  fields.wav_bytes = hs.fs.attributes(WAV, "size") or 0
  fields.held_seconds = math.floor((hs.timer.secondsSinceEpoch() - startedAt) * 100) / 100
  local f = io.open(PTT_LOG, "a")
  if f then
    f:write(hs.json.encode(fields) .. "\n")
    f:close()
  end
end

local function stopUi()
  if alertId then
    hs.alert.closeSpecific(alertId)
    alertId = nil
  end
  if watchdog then
    watchdog:stop()
    watchdog = nil
  end
  if deadAirTimer then
    deadAirTimer:stop()
    deadAirTimer = nil
  end
end

local function dispatch(exitCode, stderrTail)
  local size = hs.fs.attributes(WAV, "size") or 0
  if size <= 44 then -- a wav of header-only size means no audio ever arrived
    logTake({ outcome = "empty", exit_code = exitCode, stderr = stderrTail })
    notify("recording produced no audio — check Hammerspoon's microphone permission")
    return
  end
  logTake({ outcome = "dispatched", exit_code = exitCode })
  -- Failure notifications belong to the script (mirrors raycast/heybob.sh); success
  -- needs nothing here, because the router's acknowledgement is already speech.
  hs.task.new("/bin/bash", nil, { DISPATCH, WAV }):start()
end

local function onRecorderExit(exitCode, _, stdErr)
  local wasCancelled = cancelled
  local stderrTail = stdErr and stdErr:sub(-800) or ""
  recorder = nil
  if killTimer then
    killTimer:stop()
    killTimer = nil
  end
  stopUi()
  if wasCancelled then
    logTake({ outcome = deadAir and "dead-air" or "cancelled", exit_code = exitCode, stderr = deadAir and stderrTail or nil })
    return
  end
  if hs.timer.secondsSinceEpoch() - startedAt < MIN_SECONDS then
    logTake({ outcome = "too-short", exit_code = exitCode })
    return
  end
  dispatch(exitCode, stderrTail)
end

local function stopRecording(cancel)
  if not recorder then return end
  cancelled = cancel
  local task = recorder
  task:interrupt() -- SIGINT: ffmpeg finalises the wav header, then onRecorderExit fires
  -- An ffmpeg wedged opening its input device ignores SIGINT (its graceful handler never
  -- runs while blocked in CoreAudio), which would leave `recorder` set forever — and the
  -- Esc tap swallows every Esc on the machine for as long as it is. Escalate to SIGKILL;
  -- onRecorderExit fires on a killed task too, so the state always unwinds.
  killTimer = hs.timer.doAfter(KILL_GRACE, function()
    killTimer = nil
    if recorder == task and task:isRunning() then
      hs.execute("/bin/kill -9 " .. tostring(task:pid()))
    end
  end)
end

local function startRecording()
  hs.fs.mkdir(HOME .. "/bob/state")
  hs.fs.mkdir(HOME .. "/bob/logs")
  os.remove(WAV)
  cancelled = false
  deadAir = false
  startedAt = hs.timer.secondsSinceEpoch()
  recorder = hs.task.new(FFMPEG, onRecorderExit, {
    "-y",
    "-loglevel",
    "info", -- stderr is kept in the take log now; "error" starved it of the capture diagnostics
    "-f",
    "avfoundation",
    "-i",
    ":default", -- follows the system default input device
    "-ac",
    "1",
    "-ar",
    "16000", -- mono 16 kHz PCM: Scribe's low-latency preference, and small uploads
    "-flush_packets",
    "1", -- every packet hits disk immediately: the dead-air check below reads file size
    WAV,
  })
  recorder:start()
  -- Runtime language is the owner's (the clarify_fallback_text precedent).
  alertId = hs.alert.show("🎙️ Bob figyel…", MAX_SECONDS)
  watchdog = hs.timer.doAfter(MAX_SECONDS, function()
    stopRecording(false) -- treated as a release, not an error
  end)
  -- The 2026-08-16 empty-take incident: AVCaptureSession running, IO started, yet not
  -- one frame reached ffmpeg — discovered only after speaking a whole question into it.
  -- With immediate flushing, a live mic shows bytes on disk well inside 2.5s, so a still-
  -- empty wav here means the capture is dead: say so NOW, while the speaker can retry.
  deadAirTimer = hs.timer.doAfter(DEAD_AIR_SECONDS, function()
    deadAirTimer = nil
    if recorder == nil then return end
    if (hs.fs.attributes(WAV, "size") or 0) > 44 then return end
    deadAir = true
    stopRecording(true)
    hs.alert.show("🎙️✗ nincs hang a mikrofonból — engedd el, és próbáld újra", 4)
    notify("dead capture: ffmpeg got no audio frames — take logged to ~/bob/logs/ptt.jsonl")
  end)
end

local escCode = hs.keycodes.map.escape

local function chordHeld(flags)
  for name in pairs(PTT_CHORD) do
    if flags[name] ~= true then return false end
  end
  return true
end

-- Globals on purpose: an eventtap held only by a local is garbage-collected and
-- silently stops firing — the classic Hammerspoon trap.
--
-- Modifier state arrives as flagsChanged, one event per press or release; the
-- events are never swallowed, because blocking modifier updates would corrupt
-- every other shortcut on the machine.
heybobPttChordTap = hs.eventtap.new({ hs.eventtap.event.types.flagsChanged }, function(ev)
  local held = chordHeld(ev:getFlags())
  if held and recorder == nil then startRecording() end
  if not held and recorder ~= nil then stopRecording(false) end
  return false
end)
heybobPttChordTap:start()

heybobPttEscTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(ev)
  if ev:getKeyCode() == escCode and recorder ~= nil then
    stopRecording(true)
    return true -- while recording, Esc belongs to the cancel, not the frontmost app
  end
  return false
end)
heybobPttEscTap:start()
