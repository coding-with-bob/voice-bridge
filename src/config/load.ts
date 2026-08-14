/**
 * The single config loader both CLIs share (C3).
 *
 * Resolution order for the state home: explicit argument → `BOB_HOME` → `~/bob`.
 * The config file is `<home>/defaults.yaml`; absent means "all defaults",
 * malformed means a hard error naming the file and the offending key.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BobConfigSchema, DEFAULT_CONFIG, type BobConfig } from "../contracts/config.ts";

export const CONFIG_FILENAME = "defaults.yaml";

/** Thrown for anything the owner has to fix by hand; the message is the fix instruction. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Paths derived from the state home — the layout every other module reads. */
export interface BobPaths {
  homeDir: string;
  configFile: string;
  spokenDir: string;
  stateDir: string;
  logsDir: string;
  decisionLog: string;
  gcLog: string;
  conventionFile: string;
}

export interface LoadedConfig {
  config: BobConfig;
  paths: BobPaths;
  /** Whether the values came from a file or purely from the baked-in defaults. */
  source: "file" | "defaults";
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveHomeDir(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const candidate = explicit ?? env.BOB_HOME ?? join(homedir(), "bob");
  return resolve(expandTilde(candidate));
}

export function pathsFor(homeDir: string): BobPaths {
  return {
    homeDir,
    configFile: join(homeDir, CONFIG_FILENAME),
    spokenDir: join(homeDir, "spoken"),
    stateDir: join(homeDir, "state"),
    logsDir: join(homeDir, "logs"),
    decisionLog: join(homeDir, "logs", "route-decisions.jsonl"),
    gcLog: join(homeDir, "logs", "gc.jsonl"),
    conventionFile: join(homeDir, "CLAUDE.md"),
  };
}

export function loadConfig(options: { homeDir?: string } = {}): LoadedConfig {
  const homeDir = resolveHomeDir(options.homeDir);
  const paths = pathsFor(homeDir);
  const fileValues = existsSync(paths.configFile) ? readConfigFile(paths.configFile) : null;

  const merged = { home_dir: homeDir, ...DEFAULT_CONFIG, ...(fileValues ?? {}) };
  const parsed = BobConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration in ${paths.configFile}:\n${issues}`);
  }

  const declaredHome = resolve(expandTilde(parsed.data.home_dir));
  if (declaredHome !== homeDir) {
    throw new ConfigError(
      `Invalid configuration in ${paths.configFile}:\n` +
        `  home_dir: declared as ${declaredHome} but this config was loaded from ${homeDir}.\n` +
        `  Either fix home_dir, drop it (it defaults to the config's own directory), or set BOB_HOME.`,
    );
  }

  return {
    config: { ...parsed.data, home_dir: homeDir },
    paths,
    source: fileValues ? "file" : "defaults",
  };
}

function readConfigFile(configFile: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(configFile, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${configFile} as YAML: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Invalid configuration in ${configFile}: expected a mapping of keys to values.`);
  }
  return raw as Record<string, unknown>;
}
