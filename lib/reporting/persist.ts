/**
 * Publishes a calculated period into `daily_financials`.
 *
 * The stored table is a cache of what the engine produced, not a second source of truth: it
 * exists so the dashboard and Google Sheets read one agreed set of figures, and so a past
 * period keeps the numbers that were published at the time even after costs are restated.
 *
 * That is why every row carries a `calculation_version`. When the version changes, the old
 * rows are stood down rather than overwritten, so a restatement can always be explained.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { cm3Costs } from "@/lib/financial/allocation";
import type { DailyFinancialRow } from "@/lib/financial/daily-aggregation";

/**
 * Bump this whenever a change alters what the engine produces from unchanged inputs, so a
 * restated period is distinguishable from the figures published before the change.
 */
export const CALCULATION_VERSION = "2026-08-27.1";

export interface PublishResult {
  version: string;
  dates: number;
  rowsWritten: number;
}

const amount = (value: { toFixed: (dp: number) => string }) => value.toFixed(4);

export function createDailyFinancialsWriter(client: SupabaseClient, organisationId: string) {
  return {
    /**
     * Writes the range as the current published version.
     *
     * Only the dates supplied are affected. A run over one week leaves every other day alone,
     * so a targeted recalculation cannot blank out history it was never given.
     */
    async publish(
      rows: readonly DailyFinancialRow[],
      version: string = CALCULATION_VERSION,
    ): Promise<PublishResult> {
      if (rows.length === 0) return { version, dates: 0, rowsWritten: 0 };

      const payload = rows.map((row) => ({
        business_date: row.businessDate,
        net_revenue: amount(row.netRevenue),
        product_cogs: amount(row.costs.productCogs),
        cm1: amount(row.cm1),
        advertising_spend: amount(row.advertisingSpend),
        cm2: amount(row.cm2),
        variable_operating_costs: amount(cm3Costs(row.costs)),
        cm3: amount(row.cm3),
        fixed_operating_costs: amount(row.fixedOperatingCosts),
        operating_profit: amount(row.operatingProfit),
        orders: row.orders,
        new_customers: row.newCustomers,
      }));

      const { data, error } = await client.rpc("replace_daily_financials", {
        p_organisation_id: organisationId,
        p_calculation_version: version,
        p_rows: payload,
      });
      if (error) throw error;

      return { version, dates: rows.length, rowsWritten: (data as number | null) ?? rows.length };
    },
  };
}
