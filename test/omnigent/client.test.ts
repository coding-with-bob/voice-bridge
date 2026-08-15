import { describe, expect, test } from "bun:test";
import { OmnigentClient, OmnigentError } from "../../src/omnigent/client.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubClient(routes: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const client = new OmnigentClient({
    baseUrl: "http://127.0.0.1:6767",
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      const path = new URL(url).pathname;
      const payload = routes[path] ?? routes["*"] ?? {};
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, calls };
}

const agents = {
  data: [
    { id: "ag_sdk", name: "debby", harness: "claude-sdk" },
    { id: "ag_claude", name: "claude-native-ui", harness: "claude-native" },
  ],
};
const hosts = {
  hosts: [
    { host_id: "host_dead", name: "old", status: "offline" },
    { host_id: "host_live", name: "mac", status: "online" },
  ],
};

describe("health", () => {
  test("reports ok when the server answers", async () => {
    const { client } = stubClient({ "/health": { status: "ok" } });
    expect(await client.health()).toMatchObject({ ok: true });
  });

  test("reports not-ok rather than throwing when the server is unreachable", async () => {
    const client = new OmnigentClient({
      baseUrl: "http://127.0.0.1:6767",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    const report = await client.health();
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("connection refused");
  });
});

describe("listSessions", () => {
  test("reads the pool and parses each entry", async () => {
    const { client, calls } = stubClient({
      "/v1/sessions": { data: [{ id: "conv_1", status: "idle", created_at: 1, title: "t" }] },
    });
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("t");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/sessions");
  });
});

describe("createSession", () => {
  const routes = {
    "/v1/agents": agents,
    "/v1/hosts": hosts,
    "/v1/sessions": { id: "conv_new" },
  };

  test("resolves the claude-native agent and an online host by itself", async () => {
    const { client, calls } = stubClient(routes);
    const created = await client.createSession({
      workspace: "/Users/felho/dev/confpipeline",
      permissionMode: "bypassPermissions",
    });

    expect(created.id).toBe("conv_new");
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toMatchObject({
      agent_id: "ag_claude",
      host_id: "host_live",
      workspace: "/Users/felho/dev/confpipeline",
    });
  });

  test("carries the permission mode through terminal_launch_args", async () => {
    const { client, calls } = stubClient(routes);
    await client.createSession({ workspace: "/tmp", permissionMode: "bypassPermissions" });
    const post = calls.find((call) => call.method === "POST")!;
    expect((post.body as { terminal_launch_args: string[] }).terminal_launch_args).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("appends the C6 convention as a launch arg when one is given", async () => {
    const { client, calls } = stubClient(routes);
    await client.createSession({
      workspace: "/tmp",
      permissionMode: "bypassPermissions",
      appendSystemPrompt: "speak on finish",
    });
    const post = calls.find((call) => call.method === "POST")!;
    expect((post.body as { terminal_launch_args: string[] }).terminal_launch_args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      "speak on finish",
    ]);
  });

  test("refuses when no host is online — better a clear error than a session nowhere", async () => {
    const { client } = stubClient({
      ...routes,
      "/v1/hosts": { hosts: [{ host_id: "h", status: "offline" }] },
    });
    await expect(client.createSession({ workspace: "/tmp", permissionMode: "x" })).rejects.toThrow(
      /host/i,
    );
  });

  test("refuses when the claude-native agent is missing", async () => {
    const { client } = stubClient({ ...routes, "/v1/agents": { data: [agents.data[0]] } });
    await expect(client.createSession({ workspace: "/tmp", permissionMode: "x" })).rejects.toThrow(
      /claude-native/,
    );
  });
});

describe("postMessage and stopSession", () => {
  test("posts a user message in the event envelope", async () => {
    const { client, calls } = stubClient({ "*": { queued: true } });
    await client.postMessage("conv_1", "do the thing");
    expect(calls[0]!.url).toContain("/v1/sessions/conv_1/events");
    expect(calls[0]!.body).toEqual({
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text: "do the thing" }] },
    });
  });

  test("stop is an event, not a delete — the transcript must survive", async () => {
    const { client, calls } = stubClient({ "*": { queued: false } });
    await client.stopSession("conv_1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/sessions/conv_1/events");
    expect(calls[0]!.body).toEqual({ type: "stop_session", data: {} });
  });

  test("delete is a DELETE — reserved for doctor's own throwaway session", async () => {
    const { client, calls } = stubClient({ "*": { deleted: true } });
    await client.deleteSession("conv_1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/sessions/conv_1");
  });

  test("session ids are escaped into the path", async () => {
    const { client, calls } = stubClient({ "*": {} });
    await client.postMessage("../../admin", "hi");
    expect(calls[0]!.url).not.toContain("../../admin");
  });
});

describe("errors", () => {
  test("a non-2xx response becomes a typed error carrying the status", async () => {
    const { client } = stubClient({ "*": { detail: "nope" } }, 404);
    const failure = client.listSessions();
    await expect(failure).rejects.toThrow(OmnigentError);
    await expect(failure).rejects.toThrow(/404/);
  });

  test("a transport failure is wrapped, not leaked raw", async () => {
    const client = new OmnigentClient({
      baseUrl: "http://127.0.0.1:6767",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.listSessions()).rejects.toThrow(OmnigentError);
  });
});
