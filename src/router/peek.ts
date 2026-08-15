/**
 * Tier 3: the targeted transcript peek.
 *
 * Only ever used when the model says it is torn between two sessions, and only for those
 * two. This is deliberately not a search: no corpus grep per utterance, no index to keep
 * fresh — just the end of two conversations, fetched on demand, once.
 *
 * One candidate failing to load must not cost the round: it comes back with no turns, the
 * model sees that plainly, and decides on what it does have.
 */
import type { OmnigentClient } from "../omnigent/client.ts";
import type { PeekExtract } from "./context.ts";

/** Torn between two is the case this exists for; a longer shortlist is a different problem. */
export const PEEK_CANDIDATE_LIMIT = 2;
/** Enough turns to see how a conversation ended, few enough to stay prompt-sized. */
export const PEEK_TURNS = 6;
const MAX_TURN_CHARS = 400;

export async function fetchPeekExtracts(
  client: Pick<OmnigentClient, "sessionItems">,
  sessionIds: string[],
  options: { turns?: number } = {},
): Promise<PeekExtract[]> {
  const turns = options.turns ?? PEEK_TURNS;
  const shortlist = [...new Set(sessionIds)].slice(0, PEEK_CANDIDATE_LIMIT);

  return Promise.all(
    shortlist.map(async (session_id) => {
      try {
        // `desc` fetches the tail; the client hands it back in the order it was spoken.
        const items = await client.sessionItems(session_id, { limit: turns * 3, order: "desc" });
        return {
          session_id,
          turns: items.slice(-turns).map((item) => ({
            role: item.role,
            text: truncate(item.text),
          })),
        };
      } catch {
        return { session_id, turns: [] };
      }
    }),
  );
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_TURN_CHARS ? `${single.slice(0, MAX_TURN_CHARS)}…` : single;
}
