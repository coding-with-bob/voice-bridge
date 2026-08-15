# Entry: Raycast + Monologue

The whole voice entry, with no speech-to-text of our own: a Raycast script command with one
text argument, dictated into with Monologue.

## Install

1. **Raycast → Extensions → Script Commands → Add Script Directory** and pick
   `~/dev/hey-bob/raycast`.
2. Find **Hey Bob** in Raycast and assign a hotkey (`⌥Space`-adjacent is a good neighbourhood —
   something reachable with one hand while the other holds a coffee).
3. That is it. `heybob.sh` sets its own PATH, so nothing has to be configured in Raycast.

## The flow

**Hotkey → dictate → Enter.** The keyboard is touched exactly twice: once for the hotkey, once
for Enter. Monologue transcribes into the argument field; Raycast hands the text to `bob route`;
the router speaks its acknowledgement immediately and the session speaks its answer when the work
is done.

Nothing to watch and nothing to close: `bob route` exits as soon as it has dispatched. The reply
arrives as sound, whatever you are looking at by then.

## When it goes wrong

A failing run raises a macOS notification with the reason — success never does, because you
already heard the acknowledgement. A notification means the router could not dispatch at all;
`bob doctor` says why, and `bob log` shows the decision that was (or was not) made.

## The environment trap, and why the script looks like this

Raycast starts script commands with a minimal environment. Two things follow, and both were
found the hard way:

- **PATH is explicit in the script.** `bob` lives in `~/.local/bin`, and the `bun` its shebang
  needs lives in Homebrew's. Neither is on Raycast's default PATH.
- **The router launches Claude Code through `llmp claude`, not `claude`.** On this machine the
  subscription auth reaches Claude Code through the local llmp proxy, whose environment is
  injected by whoever launches it. Plain `claude` therefore works in a terminal that inherited
  that environment and reports *"Not logged in"* anywhere else — including here. The launcher is
  detected automatically (`src/router/model.ts`), and `bob doctor`'s **router** check exercises
  the real decision call so this failure surfaces at the check rather than at the microphone.

Verify the whole path the way the environment actually presents it:

```bash
env -i HOME="$HOME" /bin/zsh -lc 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin" bob doctor'
```
