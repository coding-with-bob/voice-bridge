/**
 * Executability and execution.
 *
 * A decision passing the C5 schema only proves it is well formed. It can still name a
 * session that does not exist or a directory that was never created — a schema cannot
 * check the world. So every decision is checked against the pool and the filesystem
 * *before* any side effect, and a failure routes to the deterministic fallback rather
 * than to a guess.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { RouterDecision } from "../contracts/decision.ts";
import type { OmnigentClient } from "../omnigent/client.ts";
import { firstMessage } from "./convention.ts";

export type ExecutabilityResult = { ok: true } | { ok: false; reason: string };

/** Expand `~` and make the placement path absolute before anything is checked against it. */
export function normalizeDecision(decision: RouterDecision): RouterDecision {
  if (decision.action !== "new") return decision;
  return { ...decision, cwd: expandPath(decision.cwd) };
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function checkExecutable(
  decision: RouterDecision,
  context: { candidateIds: Set<string> },
): ExecutabilityResult {
  switch (decision.action) {
    case "continue":
      return context.candidateIds.has(decision.session_id)
        ? { ok: true }
        : {
            ok: false,
            reason: `session "${decision.session_id}" is not in the candidate pool`,
          };
    case "new": {
      if (!isAbsolute(decision.cwd)) {
        return { ok: false, reason: `cwd "${decision.cwd}" is not an absolute path` };
      }
      if (!isDirectory(decision.cwd)) {
        return { ok: false, reason: `cwd "${decision.cwd}" is not an existing directory` };
      }
      return { ok: true };
    }
    case "clarify":
      return { ok: true };
    case "lookup_ledger":
      // The reach-back mechanism arrives in M4; until then an honest fallback beats a
      // silently ignored request for context the model said it needed.
      return { ok: false, reason: "ledger lookup is not available yet" };
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface ExecuteDeps {
  client: Pick<OmnigentClient, "postMessage" | "createSession">;
  /** The C6 text, injected into every session this router spawns. */
  conventionText: string;
  permissionMode: string;
}

export interface ExecutionOutcome {
  /** The session the utterance actually reached; null when nothing was dispatched. */
  targetSessionId: string | null;
  executed: boolean;
}

export async function executeDecision(
  decision: RouterDecision,
  deps: ExecuteDeps,
): Promise<ExecutionOutcome> {
  switch (decision.action) {
    case "continue":
      // Reviving a stopped session is free: the message itself relaunches it.
      await deps.client.postMessage(decision.session_id, decision.request);
      return { targetSessionId: decision.session_id, executed: true };

    case "new": {
      const { id } = await deps.client.createSession({
        workspace: decision.cwd,
        permissionMode: deps.permissionMode,
        appendSystemPrompt: deps.conventionText,
      });
      await deps.client.postMessage(id, firstMessage(id, decision.request));
      return { targetSessionId: id, executed: true };
    }

    case "clarify":
    case "lookup_ledger":
      return { targetSessionId: null, executed: false };
  }
}
