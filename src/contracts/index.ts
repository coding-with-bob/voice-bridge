/**
 * The seams of the voice bridge. C2/C3/C5/C7 live here as types and zod schemas;
 * C1/C4/C6 are prose contracts documented in ./README.md.
 *
 * Changing any of them is a deliberate commit touching this module and every consumer.
 */
export * from "./config.ts";
export * from "./decision.ts";
export * from "./playback.ts";
export * from "./spoken-log.ts";
