#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Hey Bob
# @raycast.mode compact
# @raycast.packageName Hey Bob
# @raycast.icon 🗣️
# @raycast.argument1 { "type": "text", "placeholder": "what do you want?" }
# @raycast.description Route a spoken request into the Omnigent session pool. Dictate the argument with Monologue; the answer comes back as speech.
# @raycast.author Felho

# The whole entry point: hotkey, dictate into the argument field, enter. No STT of our own.
#
# Raycast runs script commands with a minimal PATH, so the two directories that matter are
# named explicitly: ~/.local/bin holds `bob`, Homebrew holds the `bun` its shebang needs.
#
# The router speaks its own acknowledgement, so success needs no notification — you already
# heard it. A failure is the case that would otherwise be silent, so that is what gets one.

set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

utterance="${1:-}"
if [ -z "$utterance" ]; then
  echo "Nothing to route."
  exit 0
fi

output=$(bob route "$utterance" 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  message=$(printf '%s' "$output" | tail -n 1 | tr -d '"')
  osascript -e "display notification \"${message}\" with title \"Hey Bob\" subtitle \"routing failed\" sound name \"Basso\"" >/dev/null 2>&1
  echo "$output"
  exit "$status"
fi

printf '%s\n' "$output" | head -n 2
