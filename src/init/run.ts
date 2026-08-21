/**
 * `bob init` — the state home, from nothing, in one command.
 *
 * Everything else in the bridge assumes the home already exists: the config loader reads
 * `<home>/defaults.yaml`, the ledgers append into `<home>/spoken` and `<home>/logs`, and the
 * router hard-fails without the C6 convention in `<home>/CLAUDE.md`. That last one is the
 * reason this command exists: a fresh clone routes perfectly and never speaks back, which is
 * the most confusing failure the bridge has. `bob doctor` names it; `bob init` fixes it.
 *
 * Two rules make it safe to run at any time. It never overwrites — an existing file is
 * reported and left exactly as it is, because the CLAUDE.md is the owner's canonical
 * convention the moment they edit it, and re-seeding it would silently revert their words.
 * And it reports every item either way, so a second run is a readable inventory of the home
 * rather than a silent success.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pathsFor, resolveHomeDir } from "../config/load.ts";
import { CONFIG_TEMPLATE, CONVENTION_TEMPLATE } from "./templates.ts";

export interface InitItem {
  path: string;
  kind: "dir" | "file";
  status: "created" | "exists";
  /** What the thing is for — the report is also the explanation of the layout. */
  purpose: string;
}

export interface InitResult {
  home_dir: string;
  items: InitItem[];
  /** How many items this run actually made; 0 means the home was already complete. */
  created: number;
}

export interface InitOptions {
  /** An explicit home, resolved exactly as every other command resolves it. */
  homeDir?: string;
  /** Environment to read `BOB_HOME` from; injected so tests need not mutate the process. */
  env?: Record<string, string | undefined>;
}

export function runInit(options: InitOptions = {}): InitResult {
  const homeDir = resolveHomeDir(options.homeDir, options.env);
  const paths = pathsFor(homeDir);
  const items: InitItem[] = [
    dir(paths.homeDir, "the state home"),
    dir(paths.spokenDir, "the spoken ledger — every sentence actually heard"),
    dir(paths.stateDir, "lock files and other runtime scratch"),
    dir(paths.logsDir, "routing decisions and what the sweep stopped"),
    file(paths.conventionFile, CONVENTION_TEMPLATE, "the C6 speak-on-finish convention"),
    file(paths.configFile, CONFIG_TEMPLATE, "configuration — every key documented, all optional"),
  ];

  return {
    home_dir: homeDir,
    items,
    created: items.filter((item) => item.status === "created").length,
  };
}

function dir(path: string, purpose: string): InitItem {
  if (existsSync(path)) return { path, kind: "dir", status: "exists", purpose };
  mkdirSync(path, { recursive: true });
  return { path, kind: "dir", status: "created", purpose };
}

function file(path: string, contents: string, purpose: string): InitItem {
  // `wx` rather than an existsSync branch: the check and the write are one syscall, so a
  // second `bob init` racing the first cannot land between them and clobber a real file.
  try {
    writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
    return { path, kind: "file", status: "created", purpose };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { path, kind: "file", status: "exists", purpose };
    }
    throw error;
  }
}
