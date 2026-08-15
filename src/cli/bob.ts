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
import { route, type RouteResult } from "../router/route.ts";
import { claudeCliCall } from "../router/model.ts";
import { readConvention, ConventionError } from "../router/convention.ts";
import { listProjectDirs, PROJECTS_ROOT } from "../router/projects.ts";
import { speak } from "../say/speak.ts";
import { sayEngine } from "../say/engines/say.ts";
import { elevenLabsEngine } from "../say/engines/elevenlabs.ts";

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
  .option("--dry-run", "decide and log, but touch neither the pool nor the speakers")
  .action(async (utterance: string, options: { json?: boolean; dryRun?: boolean }) => {
    try {
      const { config, paths } = loadConfig();
      const result = await route(utterance, {
        client: new OmnigentClient({ baseUrl: config.omnigent_url }),
        config,
        paths,
        modelCall: claudeCliCall,
        conventionText: readConvention(paths.conventionFile),
        projectsRoot: PROJECTS_ROOT,
        projectDirs: listProjectDirs(),
        speak: async (text: string) => {
          // Sessionless on purpose: a router ack is not an interaction with any session,
          // so the recency derivation must not see it as one.
          await speak({
            text,
            sessionId: null,
            homeDir: config.home_dir,
            defaultVoice: config.default_voice,
            engines: { say: sayEngine, elevenlabs: elevenLabsEngine },
          });
        },
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });

      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printRouteResult(result, options.dryRun === true);
    } catch (error) {
      console.error(`bob route: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(isSetupError(error) ? 2 : 1);
    }
  });

program
  .command("doctor")
  .description("check the platform: server health, localhost bind, host daemon, spawn smoke test")
  .option("--json", "emit the report as JSON")
  .option("--quick", "skip the spawn smoke test (no session is created)")
  .action(async (options: { json?: boolean; quick?: boolean }) => {
    try {
      const { config, source, paths } = loadConfig();
      const report = await runDoctor({
        client: new OmnigentClient({ baseUrl: config.omnigent_url }),
        omnigentUrl: config.omnigent_url,
        homeDir: config.home_dir,
        configSource: source,
        conventionFile: paths.conventionFile,
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

function printRouteResult(result: RouteResult, dryRun: boolean): void {
  const target =
    result.decision.action === "continue"
      ? `continue ${result.decision.session_id}`
      : result.decision.action === "new"
        ? `new session in ${result.decision.cwd}${
            result.target_session_id === null ? "" : ` (${result.target_session_id})`
          }`
        : result.decision.action;

  console.log(`${dryRun ? "[dry run] " : ""}${target}${result.fallback ? " [fallback]" : ""}`);
  console.log(`${dryRun ? "would say" : "said"}: ${result.spoken}`);
  if (result.fallback_reason !== undefined) console.log(`reason: ${result.fallback_reason}`);
  console.log(`decided in ${result.latency_ms}ms · context: ${result.context_digest}`);
}

/** Setup problems (exit 2) need a human; routing problems (exit 1) may be worth retrying. */
function isSetupError(error: unknown): boolean {
  return error instanceof ConfigError || error instanceof ConventionError;
}

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
