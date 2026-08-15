import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectDirs, PROJECTS_ROOT } from "../../src/router/projects.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-projects-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listProjectDirs", () => {
  test("lists directory names, sorted", () => {
    mkdirSync(join(root, "craft"));
    mkdirSync(join(root, "avocado"));
    expect(listProjectDirs(root)).toEqual(["avocado", "craft"]);
  });

  test("skips files and hidden entries", () => {
    mkdirSync(join(root, "craft"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "notes.md"), "not a project");
    expect(listProjectDirs(root)).toEqual(["craft"]);
  });

  test("a missing root is empty, not an error — everything then lands at home", () => {
    expect(listProjectDirs(join(root, "absent"))).toEqual([]);
  });

  test("the real root is ~/dev, per the placement convention", () => {
    expect(PROJECTS_ROOT.endsWith("/dev")).toBe(true);
  });

  test("a symlinked project directory counts", () => {
    const target = join(root, "real");
    mkdirSync(target);
    symlinkSync(target, join(root, "linked"));
    expect(listProjectDirs(root)).toEqual(["linked", "real"]);
  });
});
