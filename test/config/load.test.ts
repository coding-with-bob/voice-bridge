import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveHomeDir, ConfigError } from "../../src/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (yaml: string) => writeFileSync(join(dir, "defaults.yaml"), yaml, "utf8");

describe("resolveHomeDir", () => {
  test("prefers the explicit argument", () => {
    expect(resolveHomeDir("/tmp/elsewhere", { BOB_HOME: "/tmp/env" })).toBe("/tmp/elsewhere");
  });

  test("falls back to BOB_HOME, then to ~/bob", () => {
    expect(resolveHomeDir(undefined, { BOB_HOME: "/tmp/env" })).toBe("/tmp/env");
    expect(resolveHomeDir(undefined, {})).toBe(join(homedir(), "bob"));
  });

  test("expands a tilde in BOB_HOME", () => {
    expect(resolveHomeDir(undefined, { BOB_HOME: "~/elsewhere" })).toBe(
      join(homedir(), "elsewhere"),
    );
  });
});

describe("loadConfig — happy paths", () => {
  test("a missing config file yields the baked-in defaults", () => {
    const loaded = loadConfig({ homeDir: dir });
    expect(loaded.source).toBe("defaults");
    expect(loaded.config.followup_window_min).toBe(DEFAULT_CONFIG.followup_window_min);
    expect(loaded.config.gc_idle_hours).toBe(DEFAULT_CONFIG.gc_idle_hours);
    expect(loaded.config.candidate_window_days).toBe(DEFAULT_CONFIG.candidate_window_days);
    expect(loaded.config.omnigent_url).toBe(DEFAULT_CONFIG.omnigent_url);
  });

  test("a partial file overrides only what it names", () => {
    write("followup_window_min: 45\n");
    const { config, source } = loadConfig({ homeDir: dir });
    expect(source).toBe("file");
    expect(config.followup_window_min).toBe(45);
    expect(config.gc_idle_hours).toBe(DEFAULT_CONFIG.gc_idle_hours);
  });

  test("an empty file is treated as all-defaults", () => {
    write("");
    expect(loadConfig({ homeDir: dir }).config.followup_window_min).toBe(
      DEFAULT_CONFIG.followup_window_min,
    );
  });

  test("home_dir defaults to the directory the config was found in", () => {
    write("followup_window_min: 45\n");
    expect(loadConfig({ homeDir: dir }).config.home_dir).toBe(dir);
  });

  test("a declared home_dir that matches the resolution root is accepted", () => {
    write(`home_dir: "${dir}"\n`);
    expect(loadConfig({ homeDir: dir }).config.home_dir).toBe(dir);
  });

  test("derived paths hang off the resolved home", () => {
    const { paths } = loadConfig({ homeDir: dir });
    expect(paths.spokenDir).toBe(join(dir, "spoken"));
    expect(paths.stateDir).toBe(join(dir, "state"));
    expect(paths.decisionLog).toBe(join(dir, "logs", "route-decisions.jsonl"));
    expect(paths.gcLog).toBe(join(dir, "logs", "gc.jsonl"));
    expect(paths.conventionFile).toBe(join(dir, "CLAUDE.md"));
  });
});

describe("loadConfig — malformed config is a hard, explained error", () => {
  const expectConfigError = (fn: () => unknown, ...fragments: string[]) => {
    let caught: unknown;
    try {
      fn();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    for (const fragment of fragments) expect(message).toContain(fragment);
  };

  test("unparseable YAML", () => {
    write("followup_window_min: [1,\n  broken");
    expectConfigError(() => loadConfig({ homeDir: dir }), "defaults.yaml");
  });

  test("a non-mapping document", () => {
    write("- just\n- a list\n");
    expectConfigError(() => loadConfig({ homeDir: dir }), "mapping");
  });

  test("a wrong value type", () => {
    write('followup_window_min: "half an hour"\n');
    expectConfigError(() => loadConfig({ homeDir: dir }), "followup_window_min");
  });

  test("an out-of-range value", () => {
    write("gc_idle_hours: -3\n");
    expectConfigError(() => loadConfig({ homeDir: dir }), "gc_idle_hours");
  });

  test("an unknown key — typos must not be silently ignored", () => {
    write("folowup_window_min: 45\n");
    expectConfigError(() => loadConfig({ homeDir: dir }), "folowup_window_min");
  });

  test("a home_dir that contradicts where the config actually lives", () => {
    write('home_dir: "/tmp/somewhere-else"\n');
    expectConfigError(() => loadConfig({ homeDir: dir }), "home_dir", dir);
  });

  test("a malformed omnigent_url", () => {
    write('omnigent_url: "not a url"\n');
    expectConfigError(() => loadConfig({ homeDir: dir }), "omnigent_url");
  });

  test("the error names the file so the fix is obvious", () => {
    mkdirSync(join(dir, "nested"));
    write("gc_idle_hours: 0\n");
    expectConfigError(() => loadConfig({ homeDir: dir }), join(dir, "defaults.yaml"));
  });
});
