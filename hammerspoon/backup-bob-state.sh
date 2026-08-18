#!/bin/bash
# Daily snapshot of the Hey Bob state home into iCloud Drive.
#
# What it protects: the spoken ledger and the logs. Those are what git does NOT keep —
# they are runtime data, deliberately gitignored — and the ledger is the router's long-term
# memory: it is what lets an utterance reach back to "that subtitle thing from July". The
# authored files (CLAUDE.md, defaults.yaml) live in a private GitHub repo as well; they ride
# along here so a restore needs one place, not two.
#
# Why Hammerspoon drives this and launchd does not: a launchd agent cannot READ iCloud Drive
# paths — macOS asks the user for that permission, and a scheduled agent has nobody to ask,
# so the system denies it silently ("Operation not permitted"). Measured 2026-08-18: from
# launchd, writing into iCloud works but listing the directory does not, which is enough to
# break any backup that checks what it already wrote. Hammerspoon was granted the permission
# by the person, once, in a dialog — and a process it spawns inherits that.
#
# Cadence is a daily *check* with an age gate rather than an alarm clock: the machine is
# asleep at any particular hour often enough that a fixed firing time silently skips days.
#
# Runnable by hand too: bash backup-bob-state.sh [--force]

set -uo pipefail

SOURCE="$HOME/bob"
DEST="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Backup/hey-bob-state"
LOG="$HOME/Library/Logs/heybob-backup.log"
MIN_AGE_HOURS=20
KEEP=14
# state/ is lock files and in-flight scratch: worthless a second after it is written.
# .git is excluded on purpose too. It is the many-small-files hazard cloud sync is worst at
# (a half-synced object store is a broken repo), it is already backed up twice — the private
# GitHub remote and a `gbb` bundle — and it is the one thing here that has actually failed to
# copy cleanly (2026-08-18, a file changed under `cp` mid-run). What belongs in a file
# snapshot is the data git deliberately does not keep.
EXCLUDE=(state .git)

log() { echo "[heybob-backup] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

force=no
[ "${1:-}" = "--force" ] && force=yes

if [ ! -d "$SOURCE" ]; then
  log "abort: $SOURCE does not exist"
  exit 1
fi

if ! mkdir -p "$DEST" 2>/dev/null; then
  log "abort: cannot reach $DEST — iCloud permission missing? (run from Hammerspoon or a terminal)"
  exit 1
fi

# The age gate: skip when the newest snapshot is younger than MIN_AGE_HOURS.
if [ "$force" = no ]; then
  newest=$(find "$DEST" -maxdepth 1 -type d -name 'bob-*' -mmin -$((MIN_AGE_HOURS * 60)) 2>/dev/null | sort | tail -n 1)
  if [ -n "$newest" ]; then
    log "skip: a snapshot younger than ${MIN_AGE_HOURS}h exists ($(basename "$newest"))"
    exit 0
  fi
fi

snapshot="$DEST/bob-$(date '+%Y-%m-%d_%H%M')"
if ! mkdir -p "$snapshot" 2>/dev/null; then
  log "abort: cannot create $snapshot"
  exit 1
fi

copied=0
for entry in "$SOURCE"/* "$SOURCE"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  skip=no
  for excluded in "${EXCLUDE[@]}"; do
    [ "$name" = "$excluded" ] && skip=yes
  done
  [ "$skip" = yes ] && continue
  if cp -R "$entry" "$snapshot/" 2>/dev/null; then
    copied=$((copied + 1))
  else
    log "warn: could not copy $name"
  fi
done

if [ "$copied" -eq 0 ]; then
  rmdir "$snapshot" 2>/dev/null
  log "abort: nothing could be copied — leaving no empty snapshot behind"
  exit 1
fi

# Retention, newest kept. A backup nobody prunes eventually fills the place it protects.
# Written for the bash macOS actually ships (3.2): no mapfile, no readarray.
total=$(find "$DEST" -maxdepth 1 -type d -name 'bob-*' 2>/dev/null | wc -l | tr -d ' ')
removed=0
if [ "$total" -gt "$KEEP" ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -rf "$old" 2>/dev/null && removed=$((removed + 1))
  done < <(find "$DEST" -maxdepth 1 -type d -name 'bob-*' 2>/dev/null | sort | head -n $((total - KEEP)))
fi

log "done: $(basename "$snapshot") · $copied item(s) · $(du -sh "$snapshot" 2>/dev/null | cut -f1) · pruned $removed"
