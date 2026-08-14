#!/usr/bin/env bun
/**
 * `bobsay` — the TTS CLI sessions call to speak a result (C1).
 * Speaking itself arrives in M1; this is the surface it will fill.
 */
import { Command } from "commander";
import { version } from "../version.ts";

const program = new Command();

program
  .name("bobsay")
  .description("Speak one sentence out loud and record it in the spoken log")
  .version(version)
  .argument("<text>", "the sentence to speak — plain, no markdown")
  .option("--session <id>", "the session speaking; omit for sessionless calls such as router acks")
  .option("--voice <engine:voice>", "override the configured default voice")
  .option("--engine <engine>", "force an engine: elevenlabs | say")
  .option("--json", "emit {spoken_text, engine, voice, log_path}")
  .action(() => {
    console.error("bobsay cannot speak yet (arrives in M1).");
    process.exit(2);
  });

program.parse();
