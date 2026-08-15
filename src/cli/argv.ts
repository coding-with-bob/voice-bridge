/**
 * Keep a leading dash in the *text* from being read as an option.
 *
 * Both CLIs take free text as their last argument — a spoken sentence, an utterance — and a
 * sentence is entitled to begin with a hyphen ("-5 degrees tonight"). Commander sees that
 * token, decides it is an unknown option and refuses the call: the session followed the C6
 * convention exactly and nothing was spoken.
 *
 * Shape alone cannot tell an unknown option from text that starts like one — but the full
 * list of valid options can. Anything beginning with `-` that is not a known option is text,
 * and gets a `--` placed in front of it.
 */

export interface SeparateOptions {
  /** Every valid flag for this command, e.g. `["--json", "-h"]`. */
  booleanOptions: readonly string[];
  /** Valid flags that consume the following token as their value. */
  valueOptions: readonly string[];
  /** Positionals to pass over first — the verb, for a CLI with subcommands. */
  skipPositionals?: number;
}

export function separatePositional(argv: string[], options: SeparateOptions): string[] {
  if (argv.includes("--")) return argv; // the caller already said where the text begins

  const boolean = new Set(options.booleanOptions);
  const withValue = new Set(options.valueOptions);
  let remainingToSkip = options.skipPositionals ?? 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    if (withValue.has(name)) {
      if (!token.includes("=")) index += 1; // `--opt value`, not `--opt=value`
      continue;
    }
    if (boolean.has(name)) continue;

    // Not a known option: this is a positional, whatever it looks like.
    if (remainingToSkip > 0) {
      remainingToSkip -= 1;
      continue;
    }
    return token.startsWith("-") ? [...argv.slice(0, index), "--", ...argv.slice(index)] : argv;
  }
  return argv;
}
