/**
 * Defensive readers for Omnigent payloads.
 *
 * The platform is a fast-moving alpha with known shape inconsistencies (data-wrapped vs
 * flat, a status vocabulary that can grow). Routing needs a handful of fields and can
 * work without the rest, so these readers extract what they recognise, degrade unknown
 * values instead of throwing, and drop unusable entries rather than failing a whole list.
 * A missing id is the one fatal defect: a session nobody can address is not a session.
 */

export type SessionStatus = "idle" | "running" | "waiting" | "failed" | "unknown";

const KNOWN_STATUSES: readonly SessionStatus[] = ["idle", "running", "waiting", "failed"];

export interface PoolSession {
  id: string;
  title: string | null;
  workspace: string | null;
  status: SessionStatus;
  agent_name: string | null;
  /** Unix seconds. */
  created_at: number;
  /** Unix seconds; null when the session has never been touched since creation. */
  updated_at: number | null;
  archived: boolean;
  host_id: string | null;
  pending_elicitations: number;
}

export interface TextItem {
  id: string;
  role: string;
  text: string;
  created_at: number;
}

/**
 * What a correction has to know before it may interrupt: is the session busy, and is our
 * own message still waiting rather than running?
 *
 * `pending_inputs` is held in the server's memory, so a restart between the dispatch and
 * the correction empties it. An empty list therefore does not prove consumption, and the
 * caller must treat "not found" as the ambiguous reading it is.
 */
export interface SessionState {
  status: SessionStatus;
  /** `pending_id`s of un-consumed messages, in the order the server reported them. */
  pending_inputs: string[];
  /**
   * Whether the session's process is actually alive. Status cannot answer this — a stopped
   * session still reports "idle" (probed live, 2026-08-17); only liveness tells sleep from
   * an awake pause. `null` when the snapshot carried no liveness: unknown, never asleep.
   */
  runner_online: boolean | null;
}

export function parseSessionState(raw: unknown): SessionState {
  const record = unwrap(raw);
  const pending = asArray(record?.pending_inputs) ?? [];
  return {
    status: asStatus(record?.status),
    pending_inputs: pending
      .map((entry) => asString(unwrap(entry)?.pending_id))
      .filter((id): id is string => id !== null && id !== ""),
    runner_online: typeof record?.runner_online === "boolean" ? record.runner_online : null,
  };
}

export function parsePoolSession(raw: unknown): PoolSession | null {
  const record = unwrap(raw);
  if (record === null) return null;
  const id = asString(record.id);
  if (id === null) return null;

  return {
    id,
    title: asString(record.title),
    workspace: asString(record.workspace),
    status: asStatus(record.status),
    agent_name: asString(record.agent_name),
    created_at: asNumber(record.created_at) ?? 0,
    updated_at: asNumber(record.updated_at),
    archived: record.archived === true,
    host_id: asString(record.host_id),
    pending_elicitations: asNumber(record.pending_elicitations_count) ?? 0,
  };
}

export function parseSessionList(raw: unknown): PoolSession[] {
  const entries = asArray(raw) ?? asArray(unwrap(raw)?.data);
  if (entries === null) return [];
  return entries.map(parsePoolSession).filter((session): session is PoolSession => session !== null);
}

/** Message turns only — what a tier-3 peek reads. Everything else in the item stream is noise here. */
export function parseTextItems(raw: unknown): TextItem[] {
  const entries = asArray(raw) ?? asArray(unwrap(raw)?.data) ?? [];
  const items: TextItem[] = [];
  for (const entry of entries) {
    const record = unwrap(entry);
    if (record === null || record.type !== "message") continue;
    const id = asString(record.id);
    const role = asString(record.role);
    const text = textOf(record.content);
    if (id === null || role === null || text === "") continue;
    items.push({ id, role, text, created_at: asNumber(record.created_at) ?? 0 });
  }
  return items;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts = asArray(content);
  if (parts === null) return "";
  return parts
    .map((part) => asString(unwrap(part)?.text) ?? "")
    .filter((text) => text !== "")
    .join(" ")
    .trim();
}

/** Accepts both the flat object and the `{data: {...}}` wrapper the server sometimes uses. */
function unwrap(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!("id" in record) && isRecord(record.data)) return record.data;
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStatus(value: unknown): SessionStatus {
  return typeof value === "string" && (KNOWN_STATUSES as readonly string[]).includes(value)
    ? (value as SessionStatus)
    : "unknown";
}
