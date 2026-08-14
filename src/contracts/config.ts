/**
 * C3 — `~/bob/defaults.yaml`.
 *
 * One schema, one loader (`src/config/load.ts`), shared by both CLIs.
 * Every field has a baked-in default, so a missing file is usable; a malformed
 * file is a hard, explained error rather than a silent half-configuration.
 */
import { z } from "zod";

/** `<engine>:<voice>` — the same shape `bobsay --voice` accepts (C1). */
export const VoiceRefSchema = z
  .string()
  .regex(/^(elevenlabs|say):.+$/, 'must be "elevenlabs:<voice-id>" or "say:<voice-name>"');

export const BobConfigSchema = z.strictObject({
  /** Within this many minutes, an utterance is presumed a follow-up to the most recent interaction. */
  followup_window_min: z.number().int().positive(),
  /** `bob gc` stops sessions idle longer than this. Stop only — never delete. */
  gc_idle_hours: z.number().positive(),
  /** Routing candidate window: a query filter over pool recency, not a session flag. */
  candidate_window_days: z.number().int().positive(),
  /** Voice used when neither the caller nor the session asks for a specific one. */
  default_voice: VoiceRefSchema,
  /** The state home. Defaults to wherever this config was found; declaring it is optional. */
  home_dir: z.string().min(1),
  omnigent_url: z.url(),
  /** Router decision model. Starts at a capable tier; downscaling is a later, evidence-based call. */
  router_model: z.string().min(1),
  /** The canned sentence spoken by the C5 deterministic fallback. Runtime language is the owner's. */
  clarify_fallback_text: z.string().min(1),
});
export type BobConfig = z.infer<typeof BobConfigSchema>;

export const DEFAULT_CONFIG: Omit<BobConfig, "home_dir"> = {
  followup_window_min: 30,
  gc_idle_hours: 3,
  candidate_window_days: 14,
  default_voice: "say:Tünde",
  omnigent_url: "http://127.0.0.1:6767",
  router_model: "claude-opus-5",
  clarify_fallback_text: "Nem értettem, hova tartozik ez. Mondanád másképp?",
};
