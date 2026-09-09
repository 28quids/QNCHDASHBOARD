/**
 * Configures the thresholds the dashboard judges QNCH against.
 *
 * Nothing here has a default value. Every threshold is supplied on the command line and stored
 * in `metric_targets`, so no number in this repository decides what "good" looks like for QNCH
 * — which is the whole point of the table existing. Until a metric has a target it produces no
 * judgement at all, and the dashboard says "no targets configured" rather than showing green.
 *
 *   npm run seed:targets -- --list
 *   npm run seed:targets -- --metrics                        # what can be targeted
 *   npm run seed:targets -- --set cm3_margin 15 --severity red
 *   npm run seed:targets -- --set blended_cac 22
 *   npm run seed:targets -- --unset cm3_margin
 *
 * **Ratio metrics are given as percentages** — `--set cm3_margin 15` means 15%, stored as
 * 0.15. The two differ by a hundredfold and both look plausible in a table, so the conversion
 * happens here rather than in someone's head.
 *
 * The comparison is derived from the metric, not supplied: a target on CAC is always a ceiling
 * and a target on margin is always a floor, and letting either be stated by hand is an
 * opportunity to get one backwards.
 */

import { connect, loadEnvFile, printTable, requireEnv } from "./lib/db.mjs";
import {
  comparisonFor,
  METRIC_CATALOGUE,
  metricDefinition,
} from "@/lib/monitoring/metric-catalogue";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const flagAt = (name: string, offset: number): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + offset];
};

const env = loadEnvFile();
const organisationId = requireEnv("ORGANISATION_ID", env);

if (has("metrics")) {
  printTable(
    METRIC_CATALOGUE.map((metric) => ({
      key: metric.key,
      basis: metric.basis,
      good: metric.direction === "higher_is_better" ? "higher" : "lower",
      description: metric.description.slice(0, 62),
    })),
  );
  console.log("\nPercentage metrics are set as percentages: --set cm3_margin 15 stores 0.15.");
  console.log("Multiples are set as they read: --set mer 3 stores 3.");
  process.exit(0);
}

const db = await connect();

try {
  if (has("list") || argv.length === 0) {
    const { rows } = await db.query(
      `select metric_key, target_value, comparison, severity, effective_from, effective_to
       from public.metric_targets
       where organisation_id = $1
       order by metric_key, effective_from desc`,
      [organisationId],
    );

    if (rows.length === 0) {
      console.log("No targets configured. The dashboard reports no health status until there are.");
      console.log("Run with --metrics to see what can be targeted.");
      process.exit(0);
    }

    printTable(
      rows.map((row) => {
        const definition = metricDefinition(row.metric_key);
        const shown =
          definition?.basis === "percentage"
            ? `${(Number(row.target_value) * 100).toFixed(1)}%`
            : String(row.target_value);
        return {
          metric: row.metric_key,
          target: `${row.comparison === "gte" ? "≥" : row.comparison === "lte" ? "≤" : "="} ${shown}`,
          severity: row.severity,
          from: row.effective_from.toISOString?.().slice(0, 10) ?? row.effective_from,
          to: row.effective_to ? (row.effective_to.toISOString?.().slice(0, 10) ?? row.effective_to) : "—",
        };
      }),
    );

    // A target against a key nothing evaluates never fires, which is indistinguishable from
    // one that is always met. Worth saying out loud rather than leaving to be discovered.
    const unknown = rows.filter((row) => !metricDefinition(row.metric_key));
    if (unknown.length > 0) {
      console.log(`\nWARNING: ${unknown.length} target(s) reference a metric that is not evaluated:`);
      for (const row of unknown) console.log(`  ${row.metric_key}`);
      console.log("They will never fire. Remove them, or correct the key.");
    }
    process.exit(0);
  }

  if (has("unset")) {
    const key = flagAt("unset", 1);
    if (!key) throw new Error("--unset needs a metric key");

    // End-dated rather than deleted, so a past period keeps the target it was judged against
    // and a restatement does not silently change what was reported at the time.
    const { rowCount: ended } = await db.query(
      `update public.metric_targets
       set effective_to = current_date
       where organisation_id = $1 and metric_key = $2 and effective_to is null`,
      [organisationId, key],
    );
    console.log(
      (ended ?? 0) > 0
        ? `Ended ${ended} target(s) on ${key} as of today. Past periods keep theirs.`
        : `${key} had no active target.`,
    );
    process.exit(0);
  }

  if (has("set")) {
    const key = flagAt("set", 1);
    const raw = flagAt("set", 2);
    const severity = flagAt("severity", 1) ?? "amber";
    const from = flagAt("from", 1) ?? new Date().toISOString().slice(0, 10);

    if (!key || raw === undefined) throw new Error("--set needs a metric key and a value");

    const definition = metricDefinition(key);
    if (!definition) {
      throw new Error(`Unknown metric ${key}. Run with --metrics for the list.`);
    }
    if (severity !== "amber" && severity !== "red") {
      throw new Error(`Severity must be amber or red, not ${severity}`);
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${raw} is not a number`);

    // Percentages in, ratios stored. The engine's margins are ratios, so a target of 15 rather
    // than 0.15 would never be met and would look like a catastrophic margin instead.
    const stored = definition.basis === "percentage" ? parsed / 100 : parsed;
    const comparison = comparisonFor(definition);

    await db.query("begin");
    await db.query(
      `update public.metric_targets
       set effective_to = $3::date - 1
       where organisation_id = $1 and metric_key = $2 and effective_to is null and effective_from < $3::date`,
      [organisationId, key, from],
    );
    await db.query(
      `insert into public.metric_targets
         (organisation_id, metric_key, target_value, comparison, severity, effective_from)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (organisation_id, metric_key, effective_from)
       do update set target_value = excluded.target_value,
                     comparison = excluded.comparison,
                     severity = excluded.severity,
                     effective_to = null`,
      [organisationId, key, stored, comparison, severity, from],
    );
    await db.query("commit");

    const shown = definition.basis === "percentage" ? `${parsed}% (stored ${stored})` : String(stored);
    console.log(`${definition.label}: ${comparison === "gte" ? "at least" : "no more than"} ${shown}, ${severity}.`);
    console.log(`Effective ${from}. The dashboard picks it up on the next load.`);
    process.exit(0);
  }

  console.error("Nothing to do. Try --list, --metrics, --set or --unset.");
  process.exitCode = 1;
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
