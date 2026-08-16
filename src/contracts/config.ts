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
  /**
   * ElevenLabs speech rate: 1.0 is the voice's own pace; the API supports 0.7–1.2 and
   * warns that the extremes cost quality. At exactly 1.0 no override is sent at all,
   * so the voice's stored settings stay authoritative. The `say` engine ignores this.
   */
  elevenlabs_speed: z.number().min(0.7).max(1.2),
  /** The state home. Defaults to wherever this config was found; declaring it is optional. */
  home_dir: z.string().min(1),
  omnigent_url: z.url(),
  /** Router decision model. Starts at a capable tier; downscaling is a later, evidence-based call. */
  router_model: z.string().min(1),
  /**
   * The model every spawned session runs on, stated on the launch rather than inherited.
   * Without `--model` Claude Code falls back to `~/.claude/settings.json`, so the owner
   * changing their own terminal default silently changes the voice bridge too — observed
   * 2026-08-16, when spawned sessions had drifted onto Fable 5 with nothing to show it.
   */
  session_model: z.string().min(1),
  /**
   * Effort for spawned sessions. A closed set, so a typo is a config error here rather than
   * a session that starts, fails inside a terminal nobody is watching, and leaves the pool
   * looking healthy.
   */
  session_effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  /**
   * The closed vocabulary a spoken request may pick from ("do it with Fable"). Offered to
   * the router as a list it may not add to, and membership is re-checked before the session
   * is created — the same shape as placement, for the same reason: a prompt is guidance and
   * a contract is not.
   */
  session_models: z.array(z.string().min(1)).nonempty(),
  /** The canned sentence spoken by the C5 deterministic fallback. Runtime language is the owner's. */
  clarify_fallback_text: z.string().min(1),
})
  /**
   * A default outside the offered list would be a config that contradicts itself: the
   * router could never ask for the model the bridge actually runs on.
   */
  .refine((config) => config.session_models.includes(config.session_model), {
    message: "session_model must be one of session_models",
    path: ["session_model"],
  });
export type BobConfig = z.infer<typeof BobConfigSchema>;

export const DEFAULT_CONFIG: Omit<BobConfig, "home_dir"> = {
  followup_window_min: 30,
  gc_idle_hours: 3,
  candidate_window_days: 14,
  default_voice: "say:Tünde",
  elevenlabs_speed: 1.0,
  omnigent_url: "http://127.0.0.1:6767",
  router_model: "claude-opus-5",
  session_model: "claude-opus-5",
  session_effort: "high",
  session_models: ["claude-opus-5", "claude-fable-5", "claude-sonnet-5"],
  clarify_fallback_text: "Nem értettem, hova tartozik ez. Mondanád másképp?",
};
