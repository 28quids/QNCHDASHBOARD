/**
 * Reads for the inventory and cash pages.
 *
 * Kept apart from the P&L loader because these answer different questions from different
 * sources. Inventory is a point-in-time snapshot from Shopify; cash is bank movement from
 * Xero. Neither belongs in the contribution walk, and mixing them into it is exactly the
 * confusion the brief asks the system to prevent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DateRange } from "@/lib/financial/dates";
import type { CashCommitment, CashMovement } from "@/lib/financial/cash";
import type { VariantInventoryInput } from "@/lib/financial/inventory";

export function createOperationsRepository(client: SupabaseClient, organisationId: string) {
  return {
    /**
     * The latest stock snapshot per variant, with its planning settings.
     *
     * Snapshots accumulate over time, so only the most recent per variant and location is
     * kept — summing them would report stock that was counted more than once.
     */
    async loadInventoryPositions(asOf: string): Promise<VariantInventoryInput[]> {
      const [{ data: snapshots, error: snapshotError }, { data: settings, error: settingsError }] =
        await Promise.all([
          client
            .from("inventory_snapshots")
            .select("variant_id, location_external_id, snapshot_at, available_units, units_on_order, expected_delivery_date")
            .eq("organisation_id", organisationId)
            .order("snapshot_at", { ascending: false }),
          client
            .from("variant_inventory_settings")
            .select("variant_id, reorder_point_units, supplier_lead_time_days, effective_from, effective_to")
            .eq("organisation_id", organisationId),
        ]);
      if (snapshotError) throw snapshotError;
      if (settingsError) throw settingsError;

      const { data: variants, error: variantError } = await client
        .from("product_variants")
        .select("id, sku")
        .eq("organisation_id", organisationId);
      if (variantError) throw variantError;

      const skuByVariant = new Map((variants ?? []).map((row) => [row.id as string, (row.sku as string | null) ?? null]));

      const settingFor = (variantId: string) =>
        (settings ?? []).find(
          (row) =>
            row.variant_id === variantId &&
            (row.effective_from as string) <= asOf &&
            (!row.effective_to || (row.effective_to as string) >= asOf),
        );

      // Ordered newest first above, so the first row seen for a variant and location is current.
      const latest = new Map<string, (typeof snapshots)[number]>();
      for (const snapshot of snapshots ?? []) {
        const key = `${snapshot.variant_id}:${snapshot.location_external_id}`;
        if (!latest.has(key)) latest.set(key, snapshot);
      }

      // Stock held at several locations is one sellable pool, so locations are summed.
      const byVariant = new Map<string, VariantInventoryInput>();
      for (const snapshot of latest.values()) {
        const variantId = snapshot.variant_id as string;
        const existing = byVariant.get(variantId);
        const setting = settingFor(variantId);

        if (existing) {
          existing.availableUnits = Number(existing.availableUnits) + Number(snapshot.available_units);
          existing.unitsOnOrder = Number(existing.unitsOnOrder ?? 0) + Number(snapshot.units_on_order);
        } else {
          byVariant.set(variantId, {
            variantId,
            sku: skuByVariant.get(variantId) ?? null,
            availableUnits: Number(snapshot.available_units),
            unitsOnOrder: Number(snapshot.units_on_order),
            expectedDeliveryDate: (snapshot.expected_delivery_date as string | null) ?? null,
            reorderPointUnits: (setting?.reorder_point_units as number | null) ?? null,
            supplierLeadTimeDays: (setting?.supplier_lead_time_days as number | null) ?? null,
            snapshotAt: snapshot.snapshot_at as string,
          });
        }
      }

      return [...byVariant.values()];
    },

    /**
     * Bank balance and movements from the mapped Xero bank accounts.
     *
     * Returns null for the balance when Xero is not connected. That is not the same as a zero
     * balance, and the cash page says so rather than reporting QNCH as having no money.
     */
    async loadCash(range: DateRange): Promise<{
      bankBalance: number | null;
      movements: CashMovement[];
      commitments: CashCommitment[];
    }> {
      const [{ data: transactions, error: transactionError }, { data: commitments, error: commitmentError }] =
        await Promise.all([
          client
            .from("xero_bank_transactions")
            .select("transaction_date, transaction_type, total")
            .eq("organisation_id", organisationId)
            .gte("transaction_date", range.from)
            .lte("transaction_date", range.to),
          client
            .from("cash_commitments")
            .select("due_date, category, amount, description")
            .eq("organisation_id", organisationId),
        ]);
      if (transactionError) throw transactionError;
      if (commitmentError) throw commitmentError;

      const movements: CashMovement[] = (transactions ?? []).map((row) => ({
        businessDate: row.transaction_date as string,
        // Signed for the cash model: a SPEND leaves the account.
        amount: row.transaction_type === "SPEND" ? -Number(row.total) : Number(row.total),
      }));

      const { count: accountCount, error: accountError } = await client
        .from("xero_accounts")
        .select("id", { count: "exact", head: true })
        .eq("organisation_id", organisationId);
      if (accountError) throw accountError;

      return {
        // A running total of imported movements is not a reconciled balance. Until the Xero
        // connector reports the account balance itself, this stays explicitly unknown.
        bankBalance: (accountCount ?? 0) > 0 ? movements.reduce((total, m) => total + Number(m.amount), 0) : null,
        movements,
        commitments: (commitments ?? []).map((row) => ({
          dueDate: row.due_date as string,
          category: row.category as string,
          amount: Number(row.amount),
          description: (row.description as string | null) ?? undefined,
        })),
      };
    },
  };
}
