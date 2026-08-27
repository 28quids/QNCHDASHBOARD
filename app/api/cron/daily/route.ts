/**
 * The nightly pipeline: sync, recalculate, publish.
 *
 * Authenticated by a shared secret rather than a user session, because no user is present.
 * The comparison is constant-time so the endpoint cannot be used to recover the secret one
 * character at a time.
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
import { calculateAndPublish } from "@/lib/reporting/calculate";
import { addDays, toBusinessDate } from "@/lib/financial/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Days of history republished on every run, to pick up late refunds and restated costs. */
const RECALCULATION_WINDOW_DAYS = 45;

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
  const today = toBusinessDate(new Date(), businessTimezone);
  const range = { from: addDays(today, -(RECALCULATION_WINDOW_DAYS - 1)), to: today };

  const result = await calculateAndPublish(client, { organisationId, businessTimezone, range });

  if (result.status === "not_approved") {
    // Not an error: the job ran correctly and correctly declined to publish.
    return NextResponse.json(
      { status: "skipped", reason: "financial_policy_not_approved", missing: result.missing },
      { status: 200 },
    );
  }

  return NextResponse.json({
    status: "ok",
    range,
    published: result.published,
    orders: result.report.summary.orders,
    netRevenue: result.report.summary.netRevenue.toFixed(2),
    warnings: result.report.warnings,
  });
}
