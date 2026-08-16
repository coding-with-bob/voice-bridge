/**
 * C4 against the live local Omnigent server.
 *
 * Skips cleanly when the server is down, so `bun test` stays green on a machine where the
 * platform is not running — but when it is running, these are the tests that catch a
 * payload shape drifting under us, which no fixture ever will.
 *
 * The lifecycle test creates a real session and deletes it afterwards; it is the only test
 * in the suite that costs anything, and it cleans up after itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { OmnigentClient } from "../../src/omnigent/client.ts";

const BASE_URL = process.env.BOB_OMNIGENT_URL ?? "http://127.0.0.1:6767";
const client = new OmnigentClient({ baseUrl: BASE_URL });

const serverIsUp = (await client.health()).ok;
if (!serverIsUp) {
  console.warn(`omnigent integration tests skipped: no server at ${BASE_URL}`);
}

const createdSessions: string[] = [];

afterAll(async () => {
  for (const id of createdSessions) await client.deleteSession(id).catch(() => {});
});

describe.if(serverIsUp)("C4 against the live server — reads", () => {
  test("health reports ok", async () => {
    expect(await client.health()).toMatchObject({ ok: true });
  });

  test("listSessions returns addressable sessions with routing metadata", async () => {
    const sessions = await client.listSessions({ limit: 5 });
    expect(Array.isArray(sessions)).toBe(true);
    for (const session of sessions) {
      expect(session.id).toBeTruthy();
      expect(["idle", "running", "waiting", "failed", "unknown"]).toContain(session.status);
      expect(typeof session.created_at).toBe("number");
    }
  });

  test("listAgents includes the claude-native agent the router spawns", async () => {
    const agents = await client.listAgents();
    expect(agents.some((agent) => agent.harness === "claude-native")).toBe(true);
  });

  test("listHosts reports the local host daemon", async () => {
    const hosts = await client.listHosts();
    expect(hosts.some((host) => host.status === "online")).toBe(true);
  });

  test("sessionItems reads message turns from an existing session", async () => {
    const sessions = await client.listSessions({ limit: 5 });
    const session = sessions[0];
    if (session === undefined) return; // an empty pool is not a client defect
    const items = await client.sessionItems(session.id, { limit: 10 });
    for (const item of items) {
      expect(typeof item.text).toBe("string");
      expect(item.text.length).toBeGreaterThan(0);
    }
  });

  test("an unknown session id is a typed 404, not a hang", async () => {
    await expect(client.sessionItems("conv_does_not_exist")).rejects.toThrow(/404/);
  });
});

describe.if(serverIsUp)("C4 against the live server — session lifecycle", () => {
  test(
    "create, message, answer, stop, revive",
    async () => {
      const { id } = await client.createSession({
        workspace: "/tmp",
        permissionMode: "bypassPermissions",
        model: "claude-opus-5",
        effort: "high",
        title: "bob-c4-integration",
      });
      createdSessions.push(id);
      expect(id).toBeTruthy();

      await client.postMessage(id, "Reply with exactly the word: pong");
      const reply = await waitForAssistantReply(id, 45_000);
      expect(reply.toLowerCase()).toContain("pong");

      // Stop is non-sticky: the transcript survives and the next message relaunches.
      await client.stopSession(id);
      const afterStop = await client.sessionItems(id);
      expect(afterStop.length).toBeGreaterThan(0);

      const turnsBefore = afterStop.length;
      await client.postMessage(id, "Reply with exactly the word: pong2");
      const revived = await waitForAssistantReply(id, 45_000, turnsBefore);
      expect(revived.toLowerCase()).toContain("pong2");
    },
    120_000,
  );
});

/**
 * The timeout message carries what the next person will need.
 *
 * This test has been seen to fail intermittently and could not be reproduced on demand,
 * including under three concurrent runs. An unreproducible failure is only worth what its
 * error message says, so this one reports which session, how many turns it had, and what
 * the last one was — enough to tell "the runner never launched" from "it answered something
 * unexpected" without having to catch it happening.
 */
async function waitForAssistantReply(
  sessionId: string,
  timeoutMs: number,
  skipUntilCount = 0,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: { count: number; tail: string } = { count: 0, tail: "(no items)" };

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const items = await client.sessionItems(sessionId);
    lastSeen = {
      count: items.length,
      tail: items.at(-1) === undefined ? "(no items)" : `${items.at(-1)!.role}: ${items.at(-1)!.text.slice(0, 80)}`,
    };
    if (items.length <= skipUntilCount) continue;
    const reply = items.slice(skipUntilCount).filter((item) => item.role === "assistant").at(-1);
    if (reply !== undefined) return reply.text;
  }
  throw new Error(
    `no assistant reply from ${sessionId} within ${timeoutMs}ms — ` +
      `${lastSeen.count} items (expected more than ${skipUntilCount}), last was ${lastSeen.tail}`,
  );
}
