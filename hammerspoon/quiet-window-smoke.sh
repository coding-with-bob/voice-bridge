#!/bin/bash
# Manual acceptance for the barge-in quiet window (M4).
#
# Starts a long spoken answer and queues a *different* session's message behind it, then
# waits. Press the PTT chord mid-answer and say a request: the answer must stop at once,
# nothing may speak while you talk and while the router decides, then the ack plays, and
# only afterwards does the queued message from the other session.
#
# Everything it starts is plain `bobsay`; no Omnigent session is touched. That also means
# the routing bias is NOT exercised here: the session ids below are made up, so the router
# correctly refuses to be biased toward a session it cannot address. What this script tests
# is the quiet window — the cut, the silence, the ack, and the queue flowing afterwards.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG="$HOME/bob/spoken/$(date +%F).jsonl"
# Only this run's lines belong in the summary; the ledger is a long chronicle.
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S)

bun src/cli/bobsay.ts --session smoke-answer --answer smoke-a \
  "This is the answer you are meant to interrupt, and it runs for a while on purpose. \
Press the push to talk chord whenever you like, and say something short. \
The moment you press, this playback should stop dead. \
Then nothing at all should be heard while you speak and while the router thinks. \
The first thing you hear after that is the router's acknowledgement. \
Only once that has finished may the other session's queued message play. \
If you hear that queued message while you are still speaking, the quiet window is broken. \
This sentence exists only so the answer runs long enough for a comfortable press." \
  >/tmp/quiet-smoke-answer.log 2>&1 &

sleep 0.6
bun src/cli/bobsay.ts --session smoke-other \
  "This is the other session's queued message, and it waited for the quiet window to end." \
  >/tmp/quiet-smoke-other.log 2>&1 &

echo "Playing. Press the PTT chord mid-answer, say something short, release."
wait

echo
echo "--- what was actually heard, in order (this run only):"
awk -v since="$STARTED_AT" -F'"' '$4 >= since' "$LOG" |
  sed 's/.*"ts":"\([^"]*\)".*"session_id":\("[^"]*"\|null\).*"text":"\([^"]*\)".*/  \1 [\2] \3/'
echo "--- the cut, as recorded:"
tail -1 "$HOME/bob/logs/interruptions.jsonl" | cut -c1-200
