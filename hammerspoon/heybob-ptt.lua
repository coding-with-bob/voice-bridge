-- Hey Bob — push-to-talk entry (PTT v2).
--
-- Hold PTT_KEY: recording starts. Release it: recording stops and the utterance is
-- dispatched through `bob dictate` (Scribe STT → router → spoken acknowledgement).
-- Esc while holding cancels. Pauses cost nothing — the recording runs as long as the
-- key is held, which is the whole reason this exists instead of silence detection.
--
-- This module is only the ear and the finger; everything downstream is the hey-bob
-- chain. The launcher owns the environment (the M5 lesson), so every path here is
-- absolute and the dispatch script exports its own PATH exactly like the Raycast entry.

local PTT_KEY = "f13" -- any hs.keycodes.map name; pick a key the frontmost app never needs
local MAX_SECONDS = 120 -- runaway protection: a held key is not a stuck key
local MIN_SECONDS = 0.25 -- below this it was a fat-finger, not an utterance

local HOME = os.getenv("HOME")
local FFMPEG = "/opt/homebrew/bin/ffmpeg"
local DISPATCH = HOME .. "/dev/hey-bob/hammerspoon/heybob-ptt.sh"
local WAV = HOME .. "/bob/state/ptt-last.wav" -- kept until the next press: it is the debug artifact

local recorder = nil
local cancelled = false
local startedAt = 0
local alertId = nil
local watchdog = nil

local function notify(text)
  hs.notify.new({ title = "Hey Bob", informativeText = text }):send()
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
end

local function dispatch()
  local size = hs.fs.attributes(WAV, "size") or 0
  if size <= 44 then -- a wav of header-only size means no audio ever arrived
    notify("recording produced no audio — check Hammerspoon's microphone permission")
    return
  end
  -- Failure notifications belong to the script (mirrors raycast/heybob.sh); success
  -- needs nothing here, because the router's acknowledgement is already speech.
  hs.task.new("/bin/bash", nil, { DISPATCH, WAV }):start()
end

local function onRecorderExit()
  local wasCancelled = cancelled
  recorder = nil
  stopUi()
  if wasCancelled then return end
  if hs.timer.secondsSinceEpoch() - startedAt < MIN_SECONDS then return end
  dispatch()
end

local function startRecording()
  hs.fs.mkdir(HOME .. "/bob/state")
  os.remove(WAV)
  cancelled = false
  startedAt = hs.timer.secondsSinceEpoch()
  recorder = hs.task.new(FFMPEG, onRecorderExit, {
    "-y",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    ":default", -- follows the system default input device
    "-ac",
    "1",
    "-ar",
    "16000", -- mono 16 kHz PCM: Scribe's low-latency preference, and small uploads
    WAV,
  })
  recorder:start()
  -- Runtime language is the owner's (the clarify_fallback_text precedent).
  alertId = hs.alert.show("🎙️ Bob figyel…", MAX_SECONDS)
  watchdog = hs.timer.doAfter(MAX_SECONDS, function()
    if recorder then recorder:interrupt() end -- treated as a release, not an error
  end)
end

local function stopRecording(cancel)
  if not recorder then return end
  cancelled = cancel
  recorder:interrupt() -- SIGINT: ffmpeg finalises the wav header, then onRecorderExit fires
end

local keyCode = hs.keycodes.map[PTT_KEY]
local escCode = hs.keycodes.map.escape

-- Global on purpose: an eventtap held only by a local is garbage-collected and
-- silently stops firing — the classic Hammerspoon trap.
heybobPttTap = hs.eventtap.new(
  { hs.eventtap.event.types.keyDown, hs.eventtap.event.types.keyUp },
  function(ev)
    local code = ev:getKeyCode()
    local isDown = ev:getType() == hs.eventtap.event.types.keyDown

    if code == keyCode then
      local isRepeat = ev:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0
      if isDown and not isRepeat and recorder == nil then startRecording() end
      if not isDown then stopRecording(false) end
      return true -- the PTT key never reaches the frontmost app
    end

    if code == escCode and isDown and recorder ~= nil then
      stopRecording(true)
      return true
    end

    return false
  end
)
heybobPttTap:start()
