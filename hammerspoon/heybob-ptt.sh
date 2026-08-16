#!/bin/bash

# The dispatch half of the PTT entry: Hammerspoon hands over a finished wav, this
# script hands it to `bob dictate` (Scribe STT → router → spoken acknowledgement).
#
# Same environment rules as raycast/heybob.sh, for the same reason: the launcher
# (here Hammerspoon) starts us with a minimal environment, so PATH is explicit —
# ~/.local/bin holds `bob`, Homebrew holds the `bun` its shebang needs, /usr/sbin
# holds the `lsof` the bind check shells out to.
#
# The router speaks its own acknowledgement, so success needs no notification — you
# already heard it. Silence ("Heard nothing to route.") is a non-event, exit 0, and
# stays quiet too. A failure is the case that would otherwise be invisible, so that
# is what gets one.

set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

wav="${1:-}"
if [ -z "$wav" ] || [ ! -f "$wav" ]; then
  osascript -e 'display notification "no recording to dispatch" with title "Hey Bob" subtitle "PTT failed" sound name "Basso"' >/dev/null 2>&1
  exit 2
fi

output=$(bob dictate "$wav" 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  message=$(printf '%s' "$output" | tail -n 1 | tr -d '"')
  osascript -e "display notification \"${message}\" with title \"Hey Bob\" subtitle \"PTT failed\" sound name \"Basso\"" >/dev/null 2>&1
  echo "$output"
  exit "$status"
fi

printf '%s\n' "$output" | head -n 3
