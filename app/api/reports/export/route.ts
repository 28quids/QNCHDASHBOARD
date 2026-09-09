import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/current-user";
import { createReportingRepository } from "@/lib/reporting/reporting-repository";
import { buildPeriodSeries } from "@/lib/reporting/series";
import { metricDefinition } from "@/lib/monitoring/metric-catalogue";
import { toBusinessDate } from "@/lib/financial/dates";
import { rawValue } from "@/lib/reporting/format";
import { parseReport, type ReportSearchParams } from "../../../(dashboard)/reports/query";

export const dynamic = "force-dynamic";

/**
 * The report on screen, as CSV.
 *
 * It parses the same query string the page does and runs the same series builder, so the file
 * cannot disagree with what was shown. Reimplementing the calculation here is how an export
 * comes to quietly differ from the dashboard it was taken from.
 *
 * The session is resolved through `requireSession`, so every read still runs as the signed-in
 * user and row-level security applies: this route is not a way around the access boundary.
 *
 * Values are written unformatted. A spreadsheet has to read them as numbers, and "£1,234" and
 * "42.0%" are text — a column of those sums to nothing and averages to an error.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  const today = toBusinessDate(new Date(), session.businessTimezone);

  const params: ReportSearchParams = {};
  for (const key of new URL(request.url).searchParams.keys()) {
    const values = new URL(request.url).searchParams.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }

  const specification = parseReport(params, today);

  const repository = createReportingRepository(session.client, {
    organisationId: session.organisationId,
    businessTimezone: session.businessTimezone,
  });

  const policy = await repository.loadPolicy();
  if (policy.status === "not_approved") {
    return NextResponse.json(
      { error: "The financial policy is not approved, so no figures can be exported.", missing: policy.missing },
      { status: 409 },
    );
  }

  const series = buildPeriodSeries({
    facts: await repository.loadFacts(specification.timeframe.range, policy.policy),
    range: specification.timeframe.range,
    grain: specification.grain,
    metrics: specification.metrics,
  });

  const definitions = specification.metrics.map((key) => metricDefinition(key)!);

  const rows = [
    ["period", "from", "to", ...definitions.map((metric) => metric.key)],
    ...series.map((period) => [
      period.label,
      period.range.from,
      period.range.to,
      ...definitions.map((metric) => rawValue(period.values.get(metric.key) ?? null)),
    ]),
  ];

  const filename = `qnch-report-${specification.timeframe.range.from}-to-${specification.timeframe.range.to}.csv`;

  return new NextResponse(rows.map(toCsvRow).join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Financial figures are per-user and change on every recalculation. Caching them anywhere
      // between here and the browser would serve one person's export to another.
      "Cache-Control": "no-store, private",
    },
  });
}

/**
 * One CSV row.
 *
 * Every field is quoted and internal quotes are doubled. A period label carrying a comma —
 * "2026-08-01 to 2026-08-15" does not, but a metric label could — would otherwise split into
 * two columns and shift every figure on the row one place left.
 */
const toCsvRow = (cells: readonly string[]): string =>
  cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",");
