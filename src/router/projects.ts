/**
 * The placement vocabulary: directory names under `~/dev`.
 *
 * The `~/dev/<name>` convention is a design decision, not a setting — the whole point is
 * that no registry is maintained. Should it ever need to be configurable, that is a
 * deliberate change to C3, not a quiet constant edit here.
 *
 * Listing the real names is what keeps placement honest: the model chooses from directories
 * that exist rather than inventing a plausible path, and executability still checks the
 * choice before a session is born anywhere.
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_ROOT = join(homedir(), "dev");

export function listProjectDirs(root: string = PROJECTS_ROOT): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && isProjectDir(root, entry))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // no ~/dev is a valid state: everything then lands in the home directory
  }
}

/** Symlinks count: a linked checkout is as good a workspace as a real directory. */
function isProjectDir(root: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(root, entry.name)).isDirectory();
  } catch {
    return false; // a broken link points at no workspace
  }
}
