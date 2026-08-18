-- Hey Bob — daily backup of the state home into iCloud Drive.
--
-- This lives in Hammerspoon rather than in launchd for one measured reason: a launchd agent
-- cannot READ iCloud Drive paths. macOS asks the person for that permission in a dialog, and
-- a scheduled agent has nobody to ask, so the system denies it silently. Measured 2026-08-18:
-- from launchd, writing into iCloud succeeds while listing the directory returns "Operation
-- not permitted" — enough to break any backup that checks what it already wrote. Hammerspoon
-- was granted the permission once, by the person, and a process it spawns inherits it.
--
-- The schedule is an hourly *check*, not an alarm clock. The script itself decides whether a
-- new snapshot is due (it skips while a recent one exists), so a machine asleep at any given
-- hour costs nothing — the next hour it is awake catches up. A fixed firing time silently
-- skips days instead.

local SCRIPT = os.getenv("HOME") .. "/dev/hey-bob/hammerspoon/backup-bob-state.sh"
local CHECK_INTERVAL = 3600 -- one hour
local FIRST_CHECK_DELAY = 120 -- let a reload settle before doing disk work

local function runBackup()
  hs.task.new("/bin/bash", nil, { SCRIPT }):start()
end

-- Globals on purpose: a timer held only by a local is garbage-collected and silently stops
-- firing — the same Hammerspoon trap the PTT eventtaps have to avoid.
heybobBackupFirstRun = hs.timer.doAfter(FIRST_CHECK_DELAY, runBackup)
heybobBackupTimer = hs.timer.doEvery(CHECK_INTERVAL, runBackup)

-- Callable by hand from the terminal: hs -c "heybobBackupNow()"
function heybobBackupNow()
  hs.task.new("/bin/bash", nil, { SCRIPT, "--force" }):start()
  return "backup started — see ~/Library/Logs/heybob-backup.log"
end
