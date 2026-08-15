/**
 * The decision call: headless `claude -p`, which keeps the router on the same subscription
 * auth as everything else (R-1) instead of needing an API key of its own.
 *
 * The invocation is deliberately stripped down. `--setting-sources ""` keeps the owner's
 * personal CLAUDE.md, skills and hooks out of a routing decision — measured on 2026-08-15
 * it cut the call from 45,914 to 2,548 input tokens, and more importantly it stops ten
 * thousand tokens of unrelated instructions competing with a strict JSON contract.
 * `--allowed-tools ""` and `--strict-mcp-config` finish the job: this call thinks, it does
 * not act.
 */
import { tmpdir } from "node:os";

export class ModelCallError extends Error {
  override name = "ModelCallError";
}

export interface ModelRequest {
  system: string;
  user: string;
  model: string;
  timeoutMs: number;
}

export interface ModelResponse {
  /** The model's answer text, still unparsed. */
  raw: string;
  latencyMs: number;
}

export type ModelCall = (request: ModelRequest) => Promise<ModelResponse>;

export function claudeCliArgs(model: string, system: string): string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--system-prompt",
    system,
    "--allowed-tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
  ];
}

export const claudeCliCall: ModelCall = async (request) => {
  const started = Date.now();
  const child = Bun.spawn(claudeCliArgs(request.model, request.system), {
    cwd: tmpdir(), // neutral ground: nothing project-specific may colour a routing decision
    stdin: new TextEncoder().encode(request.user),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), request.timeoutMs);
  let code: number;
  let stdout: string;
  let stderr: string;
  try {
    [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - started;
  if (code !== 0) {
    throw new ModelCallError(
      `claude -p exited ${code} after ${latencyMs}ms${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return { raw: unwrapCliResult(stdout), latencyMs };
};

/** `--output-format json` wraps the answer; a wrapper we cannot read is not worth failing over. */
function unwrapCliResult(stdout: string): string {
  try {
    const wrapper = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
    if (wrapper.is_error === true) {
      throw new ModelCallError(`claude -p reported an error: ${String(wrapper.result ?? "")}`);
    }
    if (typeof wrapper.result === "string") return wrapper.result;
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
  }
  return stdout;
}

/**
 * Pull the decision object out of whatever came back. Models sometimes fence their JSON or
 * frame it with a sentence; salvaging that is cheaper than a fallback the person has to hear.
 * Anything genuinely unparseable returns null, and the caller falls back deterministically.
 */
export function extractJson(text: string): unknown | null {
  const direct = tryParse(text.trim());
  if (direct !== null) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced !== null) {
    const inside = tryParse(fenced[1]!.trim());
    if (inside !== null) return inside;
  }

  const braced = firstBalancedObject(text);
  return braced === null ? null : tryParse(braced);
}

function tryParse(candidate: string): unknown | null {
  if (candidate === "") return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    // A decision is an object. An array or a scalar is not a near-miss worth salvaging.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Brace matching that ignores braces inside strings, so a request containing "{" is safe. */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') inString = !inString;
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
