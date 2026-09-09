/**
 * The nightly pipeline: sync, recalculate, publish.
 *
 * Authenticated by a shared secret rather than a user session, because no user is present.
 * The comparison is constant-time so the endpoint cannot be used to recover the secret one
 * character at a time.
 *
 * It fetches from every connected provider and then recalculates. An earlier version only
 * recalculated, which meant the nightly run recomputed the same stored facts and reported
 * success while never importing an order or a pound of spend that arrived after the last
 * manual backfill.
 *
 * Recalculation deliberately covers a trailing window rather than only yesterday. A refund
 * processed today lands on today's P&L, but an order edited in Shopify changes a past day, and
 * a cost restated in settings changes every day it applies to. Recomputing only the last day
 * would leave those corrections unpublished.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getServerEnvironment } from "@/lib/env";
import { refreshEverything } from "@/lib/connectors/pipeline";
import { toBusinessDate } from "@/lib/financial/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorised(request: NextRequest, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Exposed as both verbs deliberately: Vercel Cron invokes scheduled paths with GET, while a
 * manual or external trigger is more naturally a POST. Both require the same secret.
 */
export const GET = handle;
export const POST = handle;

async function handle(request: NextRequest) {
  const environment = getServerEnvironment();
  if (!isAuthorised(request, environment.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const client = createSupabaseAdminClient();
  const organisationId = environment.ORGANISATION_ID;

  const { data: organisation, error } = await client
    .from("organisations")
    .select("business_timezone")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw error;
  if (!organisation) {
    return NextResponse.json({ error: "organisation not found" }, { status: 500 });
  }

  const businessTimezone = organisation.business_timezone as string;

  const result = await refreshEverything(client, {
    organisationId,
    businessTimezone,
    encryptionKey: environment.TOKEN_ENCRYPTION_KEY,
    // Dated, so a retried cron on the same day is a deliberate no-op rather than a re-import.
    jobDiscriminator: toBusinessDate(new Date(), businessTimezone),
  });

  const syncs = result.syncs.map((sync) => ({
    provider: sync.provider,
    resource: sync.resource,
    status: sync.outcome.status,
    written: sync.outcome.status === "failed" || sync.outcome.status === "succeeded" ? sync.outcome.written : 0,
    error: sync.outcome.status === "failed" ? sync.outcome.error.message : undefined,
  }));

  if (result.calculation?.status === "not_approved") {
    // Not an error: the job ran correctly and correctly declined to publish.
    return NextResponse.json(
      { status: "skipped", reason: "financial_policy_not_approved", missing: result.calculation.missing, syncs },
      { status: 200 },
    );
  }

  return NextResponse.json({
    // A provider that failed must not be reported as a clean run, even though the
    // recalculation still went ahead on whatever did arrive.
    status: result.allSucceeded ? "ok" : "partial",
    syncs,
    // Reported, never used to fail the run. A discrepancy between Shopify, the platforms and
    // Xero is a finding about the business, not a fault in the job that found it.
    reconciliation: result.reconciliation
      ? {
          status: result.reconciliation.status,
          unmatched: result.reconciliation.unmatched.map((check) => ({
            key: check.reconciliationKey,
            difference: check.difference?.toFixed(2) ?? null,
            message: check.message,
          })),
        }
      : null,
    dataQualityChecks: result.dataQualityChecks,
    published: result.calculation?.status === "calculated" ? result.calculation.published : null,
    orders: result.calculation?.status === "calculated" ? result.calculation.report.summary.orders : null,
    netRevenue:
      result.calculation?.status === "calculated"
        ? result.calculation.report.summary.netRevenue.toFixed(2)
        : null,
  });
}
