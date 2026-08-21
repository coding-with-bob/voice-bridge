import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVENTION_TEMPLATE, CONFIG_TEMPLATE, CONFIG_TEMPLATE_KEYS } from "../../src/init/templates.ts";
import { readConvention, CONVENTION_BUDGET_CHARS } from "../../src/router/convention.ts";
import { loadConfig } from "../../src/config/load.ts";
import { DEFAULT_CONFIG } from "../../src/contracts/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-init-templates-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Nothing personal may ship: the templates go out to whoever clones the repo. */
const PERSONAL = ["Felho", "/Users/felho"];

describe("CONVENTION_TEMPLATE", () => {
  test("carries the C6 markers, in order", () => {
    const start = CONVENTION_TEMPLATE.indexOf("<!-- C6-CONVENTION-START -->");
    const end = CONVENTION_TEMPLATE.indexOf("<!-- C6-CONVENTION-END -->");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  });

  test("is readable by the same reader the router uses, within the length budget", () => {
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, CONVENTION_TEMPLATE, "utf8");
    const convention = readConvention(file);

    expect(convention).toContain("bobsay --session");
    expect(convention).toContain("bob metadata");
    expect(convention).toContain("bob interruption");
    expect(convention).toContain("--answer");
    expect(convention.length).toBeLessThanOrEqual(CONVENTION_BUDGET_CHARS);
  });

  test("names no person and no personal path", () => {
    for (const needle of PERSONAL) expect(CONVENTION_TEMPLATE).not.toContain(needle);
  });

  test("addresses the generic owner", () => {
    expect(CONVENTION_TEMPLATE).toContain("the owner");
  });
});

describe("CONFIG_TEMPLATE", () => {
  test("names no person and no personal path", () => {
    for (const needle of PERSONAL) expect(CONFIG_TEMPLATE).not.toContain(needle);
  });

  test("mentions every configurable key", () => {
    for (const key of CONFIG_TEMPLATE_KEYS) expect(CONFIG_TEMPLATE).toContain(`${key}:`);
  });

  test("documents owner_name, the name sessions speak to", () => {
    expect(CONFIG_TEMPLATE_KEYS).toContain("owner_name");
  });

  test("has every key commented out, so the file is pure documentation", () => {
    const live = CONFIG_TEMPLATE.split("\n").filter(
      (line) => line.trim() !== "" && !line.trimStart().startsWith("#"),
    );
    expect(live).toEqual([]);
  });

  test("loads through the shared loader as the baked-in defaults", () => {
    writeFileSync(join(dir, "defaults.yaml"), CONFIG_TEMPLATE, "utf8");
    const { config } = loadConfig({ homeDir: dir });

    expect(config.home_dir).toBe(dir);
    expect(config.followup_window_min).toBe(DEFAULT_CONFIG.followup_window_min);
    expect(config.session_model).toBe(DEFAULT_CONFIG.session_model);
  });
});
