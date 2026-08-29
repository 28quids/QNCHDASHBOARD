import { resolveEffectiveByKey } from "@/lib/financial/effective-dating";
import { enumerateDates, type DateRange } from "@/lib/financial/dates";
import type { VariantCostProfile } from "@/lib/financial/domain";
import type { AlertSeverity } from "./targets";

/**
 * Data-quality checks. The dashboard must be able to say when a number is stale, incomplete
 * or unmapped, so that a fresh-looking figure is never presented on top of an old sync.
 */

export type DataQualityStatus = "pass" | "warn" | "fail";

export interface DataQualityResult {
  checkKey: string;
  status: DataQualityStatus;
  severity: AlertSeverity;
  message: string;
  observed?: Record<string, unknown>;
}

export type IntegrationProvider = "shopify" | "meta" | "tiktok" | "xero" | "google_sheets";

export interface SyncState {
  provider: IntegrationProvider;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: "succeeded" | "failed" | "running" | "queued" | "cancelled" | null;
}

const HOUR_MS = 3_600_000;

/**
 * A connector is failing if its last run failed, and stale if it has not succeeded recently.
 * A connector that has never succeeded is a failure, not a warning.
 */
export function checkSyncFreshness(
  states: readonly SyncState[],
  now: Date,
  maximumAgeHours: number,
): DataQualityResult[] {
  return states.map((state) => {
    const checkKey = `sync_freshness.${state.provider}`;

    if (!state.lastSuccessAt) {
      return {
        checkKey,
        status: "fail",
        severity: "red",
        message: `${state.provider} has never completed a successful sync`,
        observed: { lastAttemptAt: state.lastAttemptAt },
      };
    }

    const ageHours = (now.getTime() - Date.parse(state.lastSuccessAt)) / HOUR_MS;

    if (state.lastStatus === "failed") {
      return {
        checkKey,
        status: "fail",
        severity: "red",
        message: `${state.provider} sync failed. Last success ${state.lastSuccessAt}`,
        observed: { lastSuccessAt: state.lastSuccessAt, ageHours },
      };
    }

    if (ageHours > maximumAgeHours) {
      return {
        checkKey,
        status: "warn",
        severity: "amber",
        message: `${state.provider} data is ${Math.floor(ageHours)}h old`,
        observed: { lastSuccessAt: state.lastSuccessAt, ageHours },
      };
    }

    return {
      checkKey,
      status: "pass",
      severity: "green",
      message: `${state.provider} synced at ${state.lastSuccessAt}`,
      observed: { lastSuccessAt: state.lastSuccessAt },
    };
  });
}

/** Dates in the range with no record at all, which would otherwise read as a genuine zero. */
export function checkDateCoverage(checkKey: string, datesPresent: Iterable<string>, range: DateRange): DataQualityResult {
  const present = new Set(datesPresent);
  const missing = enumerateDates(range.from, range.to).filter((date) => !present.has(date));

  if (missing.length === 0) {
    return { checkKey, status: "pass", severity: "green", message: `No missing dates between ${range.from} and ${range.to}` };
  }

  return {
    checkKey,
    status: "fail",
    severity: "red",
    message: `${missing.length} missing date(s), starting ${missing[0]}`,
    observed: { missing: missing.slice(0, 10), missingCount: missing.length },
  };
}

/** Every variant that sold must have an approved cost profile, or CM1 is wrong. */
export function checkVariantCostCoverage(
  soldVariantIds: Iterable<string>,
  profiles: readonly VariantCostProfile[],
  asOf: string,
): DataQualityResult {
  const resolved = resolveEffectiveByKey(profiles, asOf, (profile) => profile.variantId);
  const unmapped = [...new Set(soldVariantIds)].filter((variantId) => !resolved.has(variantId));

  if (unmapped.length === 0) {
    return { checkKey: "cogs.coverage", status: "pass", severity: "green", message: "All variants sold have an approved cost" };
  }

  return {
    checkKey: "cogs.coverage",
    status: "fail",
    severity: "red",
    message: `${unmapped.length} variant(s) sold without an approved cost profile`,
    observed: { unmapped },
  };
}

/** Xero accounts with spend but no financial mapping are silently missing from the P&L. */
export function checkExpenseMappingCoverage(
  accountsWithActivity: Iterable<string>,
  mappedAccountIds: Iterable<string>,
): DataQualityResult {
  const mapped = new Set(mappedAccountIds);
  const unmapped = [...new Set(accountsWithActivity)].filter((accountId) => !mapped.has(accountId));

  if (unmapped.length === 0) {
    return { checkKey: "xero.mapping", status: "pass", severity: "green", message: "All active Xero accounts are mapped" };
  }

  return {
    checkKey: "xero.mapping",
    status: "warn",
    severity: "amber",
    message: `${unmapped.length} Xero account(s) with activity are not mapped to a financial category`,
    observed: { unmapped },
  };
}

export interface AdAccountTimezone {
  platform: string;
  externalId: string;
  timezone: string | null;
}

/**
 * Advertising spend is dated in the ad account's own timezone, not QNCH's.
 *
 * Meta returns `date_start` as a date already resolved in the account's timezone, so there is
 * no timestamp left to convert. When the two disagree, a day's spend is measured over a
 * different window than that day's revenue, and daily MER and CAC carry an offset.
 *
 * Reported as a warning rather than corrected, because correcting it is not possible after
 * the fact: an ad account's timezone is fixed when the account is created, and reallocating
 * a daily total across a boundary would mean inventing an hourly distribution.
 */
export function checkAdAccountTimezone(
  accounts: readonly AdAccountTimezone[],
  businessTimezone: string,
): DataQualityResult {
  const mismatched = accounts.filter(
    (account) => account.timezone !== null && account.timezone !== businessTimezone,
  );

  if (accounts.length === 0) {
    return {
      checkKey: "advertising.timezone",
      status: "pass",
      severity: "green",
      message: "No advertising accounts connected",
    };
  }

  if (mismatched.length === 0) {
    return {
      checkKey: "advertising.timezone",
      status: "pass",
      severity: "green",
      message: `All ad accounts report in ${businessTimezone}`,
    };
  }

  return {
    checkKey: "advertising.timezone",
    status: "warn",
    severity: "amber",
    message:
      `${mismatched.map((account) => `${account.platform} (${account.timezone})`).join(", ")} ` +
      `report on a different day boundary than ${businessTimezone}. Daily spend is offset ` +
      `against daily revenue; period totals are unaffected.`,
    observed: { businessTimezone, accounts: mismatched },
  };
}

/** Blocks official reporting until QNCH has approved the financial policy. */
export function checkFinancialPolicyApproved(status: "draft" | "approved"): DataQualityResult {
  return status === "approved"
    ? { checkKey: "policy.approved", status: "pass", severity: "green", message: "Financial policy is approved" }
    : {
        checkKey: "policy.approved",
        status: "fail",
        severity: "red",
        message: "Financial policy is still draft. Profit figures are provisional.",
      };
}

export interface DataQualitySummary {
  status: DataQualityStatus;
  severity: AlertSeverity;
  failing: DataQualityResult[];
  warning: DataQualityResult[];
  results: DataQualityResult[];
  /** True when the numbers are safe to present as current, without caveat. */
  isTrustworthy: boolean;
}

export function summariseDataQuality(results: readonly DataQualityResult[]): DataQualitySummary {
  const failing = results.filter((result) => result.status === "fail");
  const warning = results.filter((result) => result.status === "warn");
  const status: DataQualityStatus = failing.length > 0 ? "fail" : warning.length > 0 ? "warn" : "pass";

  return {
    status,
    severity: failing.length > 0 ? "red" : warning.length > 0 ? "amber" : "green",
    failing,
    warning,
    results: [...results],
    isTrustworthy: status === "pass",
  };
}
