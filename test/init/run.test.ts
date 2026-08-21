import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/init/run.ts";
import { CONFIG_TEMPLATE, CONVENTION_TEMPLATE } from "../../src/init/templates.ts";
import { readConvention } from "../../src/router/convention.ts";

let parent: string;
let home: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "bob-init-"));
  home = join(parent, "bob");
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const statusOf = (result: ReturnType<typeof runInit>, path: string) =>
  result.items.find((item) => item.path === path)?.status;

describe("runInit — a home from nothing", () => {
  test("creates the whole layout and reports every item as created", () => {
    const result = runInit({ homeDir: home });

    expect(result.home_dir).toBe(home);
    expect(result.created).toBe(result.items.length);
    expect(result.items.every((item) => item.status === "created")).toBe(true);

    for (const relative of ["", "spoken", "state", "logs"]) {
      const path = join(home, relative);
      expect(statSync(path).isDirectory()).toBe(true);
      expect(statusOf(result, path)).toBe("created");
    }
    for (const file of ["CLAUDE.md", "defaults.yaml"]) {
      expect(existsSync(join(home, file))).toBe(true);
      expect(statusOf(result, join(home, file))).toBe("created");
    }
  });

  test("writes the shipped templates verbatim", () => {
    runInit({ homeDir: home });
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe(CONVENTION_TEMPLATE);
    expect(readFileSync(join(home, "defaults.yaml"), "utf8")).toBe(CONFIG_TEMPLATE);
  });

  test("the CLAUDE.md it writes satisfies the router's convention reader", () => {
    runInit({ homeDir: home });
    expect(readConvention(join(home, "CLAUDE.md")).length).toBeGreaterThan(0);
  });

  test("resolves the home the way every other command does", () => {
    const result = runInit({ env: { BOB_HOME: home } });
    expect(result.home_dir).toBe(home);
    expect(existsSync(join(home, "defaults.yaml"))).toBe(true);
  });
});

describe("runInit — an existing home", () => {
  test("never overwrites a file that is already there", () => {
    runInit({ homeDir: home });
    writeFileSync(join(home, "CLAUDE.md"), "mine, with a <!-- C6-CONVENTION-START -->x<!-- C6-CONVENTION-END -->", "utf8");
    writeFileSync(join(home, "defaults.yaml"), "gc_idle_hours: 9\n", "utf8");

    const result = runInit({ homeDir: home });

    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toContain("mine, with a");
    expect(readFileSync(join(home, "defaults.yaml"), "utf8")).toBe("gc_idle_hours: 9\n");
    expect(statusOf(result, join(home, "CLAUDE.md"))).toBe("exists");
    expect(statusOf(result, join(home, "defaults.yaml"))).toBe("exists");
  });

  test("a second run changes nothing and says so", () => {
    const first = runInit({ homeDir: home });
    const second = runInit({ homeDir: home });

    expect(second.created).toBe(0);
    expect(second.items.every((item) => item.status === "exists")).toBe(true);
    expect(second.items.map((item) => item.path)).toEqual(first.items.map((item) => item.path));
  });

  test("fills in only what is missing", () => {
    runInit({ homeDir: home });
    rmSync(join(home, "logs"), { recursive: true, force: true });
    rmSync(join(home, "defaults.yaml"), { force: true });

    const result = runInit({ homeDir: home });

    expect(result.created).toBe(2);
    expect(statusOf(result, join(home, "logs"))).toBe("created");
    expect(statusOf(result, join(home, "defaults.yaml"))).toBe("created");
    expect(statusOf(result, join(home, "spoken"))).toBe("exists");
  });
});
