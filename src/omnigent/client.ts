/**
 * C4 — the only module that talks to Omnigent.
 *
 * Omnigent is adopted stock (R-8): we orchestrate over it, never into it. Keeping every
 * HTTP call behind this surface means a platform change lands in one file, and the rest
 * of the bridge never learns the wire format.
 *
 * Beyond the six methods C4 names, this module also exposes `listAgents` / `listHosts`:
 * `createSession` needs them to resolve which agent and host to launch on, and `bob doctor`
 * needs them to report host-daemon health. Both are a deliberate, documented widening —
 * the invariant that matters is that no HTTP lives outside this file.
 */
import {
  parseSessionList,
  parseTextItems,
  type PoolSession,
  type TextItem,
} from "./parse.ts";

export class OmnigentError extends Error {
  override name = "OmnigentError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HealthReport {
  ok: boolean;
  detail: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  harness: string;
}

export interface HostSummary {
  host_id: string;
  name: string;
  status: string;
}

export interface CreateSessionOptions {
  /** Absolute path the session is born in — the placement decision. */
  workspace: string;
  /** Passed through as `--permission-mode`; own-tool sessions run `bypassPermissions` per D10. */
  permissionMode: string;
  /** The C6 convention text, injected as `--append-system-prompt`. */
  appendSystemPrompt?: string;
  title?: string;
}

/** The harness we spawn: real Claude Code in a terminal, so subscription auth is preserved. */
export const CLAUDE_NATIVE_HARNESS = "claude-native";

const DEFAULT_TIMEOUT_MS = 15_000;

export class OmnigentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Never throws: doctor and the router both want a report, not an exception. */
  async health(): Promise<HealthReport> {
    try {
      const payload = await this.request<{ status?: string }>("GET", "/health");
      const status = payload?.status ?? "unknown";
      return { ok: status === "ok", detail: `server reports status=${status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async listSessions(options: { includeArchived?: boolean; limit?: number } = {}): Promise<
    PoolSession[]
  > {
    const query = new URLSearchParams();
    if (options.includeArchived) query.set("include_archived", "true");
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return parseSessionList(await this.request("GET", `/v1/sessions${suffix}`));
  }

  async createSession(options: CreateSessionOptions): Promise<{ id: string }> {
    const [agent, host] = await Promise.all([this.claudeNativeAgent(), this.onlineHost()]);

    const launchArgs = ["--permission-mode", options.permissionMode];
    if (options.appendSystemPrompt !== undefined) {
      launchArgs.push("--append-system-prompt", options.appendSystemPrompt);
    }

    const payload = await this.request<{ id?: string }>("POST", "/v1/sessions", {
      agent_id: agent.id,
      host_id: host.host_id,
      workspace: options.workspace,
      ...(options.title === undefined ? {} : { title: options.title }),
      terminal_launch_args: launchArgs,
    });

    const id = payload?.id;
    if (typeof id !== "string" || id === "") {
      throw new OmnigentError("Session creation returned no id.");
    }
    return { id };
  }

  async postMessage(sessionId: string, text: string): Promise<void> {
    await this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text }] },
    });
  }

  /** Stop, never delete: the process dies, the transcript lives, the next message revives it. */
  async stopSession(sessionId: string): Promise<void> {
    await this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      type: "stop_session",
      data: {},
    });
  }

  /**
   * Deleting is not part of the router's vocabulary — `bob gc` stops, and removing a real
   * session stays a human act. This exists so `bob doctor` can clean up the throwaway
   * session it created itself: left behind, a smoke-test session would sit in the pool as a
   * routing candidate forever.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * `order: "desc"` is what a tier-3 peek needs: the *end* of a conversation, not its
   * opening. Results are returned chronologically regardless, so callers read them the
   * way they were spoken.
   */
  async sessionItems(
    sessionId: string,
    options: { limit?: number; order?: "asc" | "desc" } = {},
  ): Promise<TextItem[]> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.order !== undefined) query.set("order", options.order);
    const suffix = query.size > 0 ? `?${query}` : "";
    const items = parseTextItems(
      await this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/items${suffix}`),
    );
    return options.order === "desc" ? items.reverse() : items;
  }

  async listAgents(): Promise<AgentSummary[]> {
    const payload = await this.request<{ data?: unknown[] }>("GET", "/v1/agents");
    return (payload?.data ?? [])
      .map((raw) => raw as Partial<AgentSummary>)
      .filter((agent): agent is AgentSummary => typeof agent.id === "string")
      .map((agent) => ({ id: agent.id, name: agent.name ?? "", harness: agent.harness ?? "" }));
  }

  async listHosts(): Promise<HostSummary[]> {
    const payload = await this.request<{ hosts?: unknown[] }>("GET", "/v1/hosts");
    return (payload?.hosts ?? [])
      .map((raw) => raw as Partial<HostSummary>)
      .filter((host): host is HostSummary => typeof host.host_id === "string")
      .map((host) => ({
        host_id: host.host_id,
        name: host.name ?? "",
        status: host.status ?? "unknown",
      }));
  }

  private async claudeNativeAgent(): Promise<AgentSummary> {
    const agents = await this.listAgents();
    const agent = agents.find((candidate) => candidate.harness === CLAUDE_NATIVE_HARNESS);
    if (agent === undefined) {
      throw new OmnigentError(
        `No ${CLAUDE_NATIVE_HARNESS} agent registered on the server — cannot spawn a session.`,
      );
    }
    return agent;
  }

  private async onlineHost(): Promise<HostSummary> {
    const hosts = await this.listHosts();
    const host = hosts.find((candidate) => candidate.status === "online");
    if (host === undefined) {
      throw new OmnigentError(
        "No online host: start the host daemon (`omnigent host`) before spawning sessions.",
      );
    }
    return host;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new OmnigentError(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new OmnigentError(
        `${method} ${path} returned ${response.status} ${response.statusText}: ${truncate(
          await safeText(response),
        )}`,
        response.status,
      );
    }
    return (await safeJson(response)) as T;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await safeText(response);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
