#!/usr/bin/env bun
/**
 * `bob` — the router CLI. Per-invocation, no daemon: it decides, dispatches, acks and exits.
 * Verbs land increment by increment (route: M3, log: M4, gc: M5).
 */
import { Command } from "commander";
import { version } from "../version.ts";
import { loadConfig, ConfigError } from "../config/load.ts";
import { OmnigentClient } from "../omnigent/client.ts";
import { readListenHosts } from "../doctor/bind.ts";
import { runDoctor, type DoctorReport } from "../doctor/run.ts";

const program = new Command();

program
  .name("bob")
  .description("Hey Bob voice bridge — routes utterances into the Omnigent session pool")
  .version(version);

program
  .command("route")
  .description("route one utterance to a session (continue), a new session, or a spoken clarify")
  .argument("<utterance>", "what was said")
  .option("--json", "emit the decision as JSON")
  .option("--dry-run", "decide and log, but do not touch the pool")
  .action(() => notYet("bob route", "M3"));

program
  .command("doctor")
  .description("check the platform: server health, localhost bind, host daemon, spawn smoke test")
  .option("--json", "emit the report as JSON")
  .option("--quick", "skip the spawn smoke test (no session is created)")
  .action(async (options: { json?: boolean; quick?: boolean }) => {
    try {
      const { config, source } = loadConfig();
      const report = await runDoctor({
        client: new OmnigentClient({ baseUrl: config.omnigent_url }),
        omnigentUrl: config.omnigent_url,
        homeDir: config.home_dir,
        configSource: source,
        readListenHosts,
        spawn: options.quick !== true,
      });

      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exit(report.ok ? 0 : 1);
    } catch (error) {
      console.error(`bob doctor: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof ConfigError ? 2 : 1);
    }
  });

program
  .command("log")
  .description("tail the spoken, decision and gc logs")
  .option("--reachbacks", "show only reach-backs to sessions past the candidate window")
  .option("--json", "emit as JSON")
  .action(() => notYet("bob log", "M4"));

program
  .command("gc")
  .description("stop sessions idle beyond gc_idle_hours (stop only — never delete)")
  .option("--dry-run", "list what would be stopped")
  .option("--json", "emit as JSON")
  .action(() => notYet("bob gc", "M5"));

await program.parseAsync();

function printReport(report: DoctorReport): void {
  for (const check of report.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(7)} ${check.detail}`);
    if (check.hint !== undefined) console.log(`            → ${check.hint}`);
  }
  console.log(report.ok ? "\nAll checks passed." : "\nSome checks failed.");
}

function notYet(verb: string, increment: string): never {
  console.error(`${verb} is not implemented yet (arrives in ${increment}).`);
  process.exit(2);
}
