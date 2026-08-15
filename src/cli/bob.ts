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
import { collectLogEvents, renderLogEvent, ALL_SOURCES } from "../router/log-view.ts";
import { runGc, type GcResult } from "../gc/run.ts";
import { appendGcEntry } from "../gc/log.ts";
import { speak } from "../say/speak.ts";
import { sayEngine } from "../say/engines/say.ts";
import { elevenLabsEngine } from "../say/engines/elevenlabs.ts";
import { separatePositional } from "./argv.ts";

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
        modelCall: claudeCliCall,
        routerModel: config.router_model,
        spawn: options.quick !== true,
      });

      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exit(report.ok ? 0 : 1);
    } catch (error) {
      console.error(`bob doctor: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(isSetupError(error) ? 2 : 1);
    }
  });

program
  .command("log")
  .description("tail the spoken, decision and gc logs as one timeline")
  .option("-n, --count <n>", "how many events to show (default 20)", "20")
  .option("--spoken", "only what was said out loud")
  .option("--decisions", "only routing decisions")
  .option("--gc", "only what the sweep stopped")
  .option("--reachbacks", "only reach-backs to sessions past the candidate window")
  .option("--json", "emit as JSON")
  .action(
    async (options: {
      count: string;
      spoken?: boolean;
      decisions?: boolean;
      gc?: boolean;
      reachbacks?: boolean;
      json?: boolean;
    }) => {
      try {
        const { config, paths } = loadConfig();
        const chosen = ALL_SOURCES.filter((source) => options[source] === true);
        const events = collectLogEvents({
          homeDir: config.home_dir,
          paths,
          ...(chosen.length > 0 ? { sources: chosen } : {}),
          ...(options.reachbacks === true ? { reachbacksOnly: true } : {}),
          limit: Math.max(1, Number(options.count) || 20),
        });

        if (options.json) console.log(JSON.stringify(events, null, 2));
        else if (events.length === 0) console.log("nothing logged yet");
        else for (const event of events) console.log(renderLogEvent(event));
      } catch (error) {
        console.error(`bob log: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(isSetupError(error) ? 2 : 1);
      }
    },
  );

program
  .command("gc")
  .description("stop sessions idle beyond gc_idle_hours (stop only — never delete)")
  .option("--dry-run", "list what would be stopped, without stopping anything")
  .option("--json", "emit as JSON")
  .action(async (options: { dryRun?: boolean; json?: boolean }) => {
    try {
      const { config, paths } = loadConfig();
      const result = await runGc({
        client: new OmnigentClient({ baseUrl: config.omnigent_url }),
        idleHours: config.gc_idle_hours,
        dryRun: options.dryRun === true,
      });

      // A dry run is logged too: knowing what a proposed sweep would have touched is
      // worth a line, and it is the record you check before running it for real.
      for (const entry of result.entries) appendGcEntry(paths.gcLog, entry);

      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printGcResult(result, options.dryRun === true, config.gc_idle_hours);
    } catch (error) {
      console.error(`bob gc: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(isSetupError(error) ? 2 : 1);
    }
  });

// Dictation can hand us an utterance that starts with a hyphen; the verb comes first,
// so one positional is skipped before the text is protected.
await program.parseAsync(
  separatePositional(process.argv.slice(2), {
    booleanOptions: ["--json", "--dry-run", "--quick", "--spoken", "--decisions", "--gc",
                     "--reachbacks", "-h", "--help", "-V", "--version"],
    valueOptions: ["-n", "--count"],
    skipPositionals: 1,
  }),
  { from: "user" },
);

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

function printGcResult(result: GcResult, dryRun: boolean, idleHours: number): void {
  if (result.entries.length === 0) {
    console.log(`nothing idle beyond ${idleHours}h among ${result.scanned} sessions`);
    return;
  }
  for (const entry of result.entries) {
    const outcome = entry.dry_run
      ? "would stop"
      : entry.stopped
        ? "stopped"
        : `could not stop (${entry.error ?? "unknown"})`;
    console.log(
      `${outcome} ${entry.session_id} · idle ${entry.idle_hours.toFixed(1)}h · ${entry.title ?? "(untitled)"}`,
    );
  }
  const verb = dryRun ? "would be stopped" : "stopped";
  console.log(`\n${result.entries.length} of ${result.scanned} sessions ${verb}.`);
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
