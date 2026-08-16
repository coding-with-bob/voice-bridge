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
 * The primitives the correction path is built on, against the real server.
 *
 * Everything the repair does was written from `server/API.md` and had never once been sent
 * to Omnigent. That is the same position we were in twice on 2026-08-16 — a dead auth token
 * that looked configured, and a schema shape the recipe taught wrongly — and both times the
 * thing that looked healthy was the thing that was broken.
 *
 * The load-bearing one is `pending_id`. Without it the repair can never prove that the
 * running turn is its own, so it takes the conservative branch every time and silently
 * stops interrupting anything. Nothing about that failure is visible from the outside.
 */
describe.if(serverIsUp)("C4 against the live server — the repair primitives", () => {
  /** Long enough to still be generating while the next assertion runs. */
  const SLOW_TASK = "Without using any tools, write out the numbers 1 to 300, one per line.";

  async function freshSession(title: string): Promise<string> {
    const { id } = await client.createSession({
      workspace: "/tmp",
      permissionMode: "bypassPermissions",
      model: "claude-opus-5",
      effort: "high",
      title,
    });
    createdSessions.push(id);
    return id;
  }

  test(
    "a native message comes back with a pending_id — the repair's only proof of ownership",
    async () => {
      const id = await freshSession("bob-c4-pending-id");
      const posted = await client.postMessage(id, "Reply with exactly the word: pong");
      expect(
        posted.pendingId,
        "no pending_id: the repair can never prove the running turn is its own, " +
          "so it will take the conservative branch forever and never interrupt",
      ).toBeTruthy();
    },
    60_000,
  );

  test(
    "a message sent behind a running turn is visible as an un-consumed input",
    async () => {
      const id = await freshSession("bob-c4-pending-inputs");
      await client.postMessage(id, SLOW_TASK);
      const second = await client.postMessage(id, "Reply with exactly the word: second");
      expect(second.pendingId).toBeTruthy();

      // "Was it ever observed queued" rather than "is it queued right now": the first turn
      // ends on its own schedule, and the assertion must not race it.
      const seen = await observedWithin(
        20_000,
        async () => (await client.sessionState(id)).pending_inputs,
        (pending) => pending.includes(second.pendingId!),
      );
      expect(
        seen,
        "the second message was never seen in pending_inputs — the repair cannot tell " +
          "a queued message from a running one, which is exactly what it must not do",
      ).toBe(true);
    },
    90_000,
  );

  test(
    "interrupt stops a running turn",
    async () => {
      const id = await freshSession("bob-c4-interrupt");
      await client.postMessage(id, SLOW_TASK);
      const started = await observedWithin(
        20_000,
        async () => (await client.sessionState(id)).status,
        (status) => status === "running" || status === "waiting",
      );
      expect(started, "the session never started working, so there was nothing to interrupt").toBe(
        true,
      );

      await client.interrupt(id);
      const stopped = await observedWithin(
        20_000,
        async () => (await client.sessionState(id)).status,
        (status) => status !== "running",
      );
      expect(stopped, "the session was still running after an interrupt").toBe(true);
    },
    90_000,
  );

  test(
    "interrupt then delete leaves nothing behind — the wrongly-born-session repair, end to end",
    async () => {
      const id = await freshSession("bob-c4-interrupt-delete");
      await client.postMessage(id, SLOW_TASK);
      await client.interrupt(id);
      await client.deleteSession(id);
      await expect(client.sessionState(id)).rejects.toThrow(/404/);
    },
    90_000,
  );

  test("a fresh session's state parses, and starts with nothing queued", async () => {
    const id = await freshSession("bob-c4-state-shape");
    const state = await client.sessionState(id);
    expect(["idle", "running", "waiting", "failed", "unknown"]).toContain(state.status);
    expect(state.pending_inputs).toEqual([]);
  });
});

/** Polls until the reading satisfies the predicate, or the deadline passes. */
async function observedWithin<T>(
  timeoutMs: number,
  read: () => Promise<T>,
  satisfied: (value: T) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (satisfied(await read())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

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
