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
     * Bank balance and movements from the connected Xero bank accounts.
     *
     * The balance is the closing balance **Xero itself reports**, taken from its Bank Summary,
     * and not a running total of whatever movements happen to have been imported. Those two
     * differ whenever an import is partial or a window is bounded, and the running total reads
     * exactly like a balance while being neither reconciled nor complete. Where no reported
     * balance exists the answer is null, which the cash page states as unknown rather than
     * showing QNCH as having no money.
     *
     * Movements are restricted to bank accounts. Every bank transaction has a bank side, so
     * this is normally every row; the filter is what stops a transaction whose bank account is
     * unresolved from being counted as cash it cannot be traced to.
     */
    async loadCash(range: DateRange): Promise<{
      bankBalance: number | null;
      /** The date the reported balance was struck, so the cash page can date what it shows. */
      bankBalanceAsAt: string | null;
      movements: CashMovement[];
      commitments: CashCommitment[];
    }> {
      const [
        { data: transactions, error: transactionError },
        { data: commitments, error: commitmentError },
        { data: balances, error: balanceError },
        { data: bills, error: billError },
      ] = await Promise.all([
        client
          .from("xero_bank_transactions")
          .select("transaction_date, transaction_type, total, reference, bank_xero_account_id")
          .eq("organisation_id", organisationId)
          .gte("transaction_date", range.from)
          .lte("transaction_date", range.to),
        client
          .from("cash_commitments")
          .select("due_date, category, amount, description")
          .eq("organisation_id", organisationId),
        client
          .from("xero_bank_balances")
          .select("as_at, closing_balance")
          .eq("organisation_id", organisationId)
          .lte("as_at", range.to)
          .order("as_at", { ascending: false }),
        // Unpaid supplier bills. Money owed but not yet paid: neither cash nor cost, which is
        // exactly what a commitment is, and why it is read here rather than in the P&L.
        client
          .from("xero_invoices")
          .select("invoice_date, due_date, status, amount_due, contact_name")
          .eq("organisation_id", organisationId)
          .eq("invoice_type", "ACCPAY")
          .gt("amount_due", 0),
      ]);
      if (transactionError) throw transactionError;
      if (commitmentError) throw commitmentError;
      if (balanceError) throw balanceError;
      if (billError) throw billError;

      const movements: CashMovement[] = (transactions ?? [])
        .filter((row) => row.bank_xero_account_id !== null)
        .map((row) => ({
          businessDate: row.transaction_date as string,
          // Signed for the cash model: a SPEND leaves the account.
          amount: row.transaction_type === "SPEND" ? -Number(row.total) : Number(row.total),
          category: (row.reference as string | null) ?? undefined,
        }));

      // Every bank account's balance on the most recent date any of them was reported, summed.
      // Taking each account's own latest row instead would add balances struck on different
      // days, which is a figure that was never true at any single moment.
      const latestAsAt = (balances ?? [])[0]?.as_at as string | undefined;
      const onLatestDate = (balances ?? []).filter((row) => row.as_at === latestAsAt);

      return {
        bankBalance:
          latestAsAt === undefined
            ? null
            : onLatestDate.reduce((total, row) => total + Number(row.closing_balance), 0),
        bankBalanceAsAt: latestAsAt ?? null,
        movements,
        commitments: [
          ...(commitments ?? []).map((row) => ({
            dueDate: row.due_date as string,
            category: row.category as string,
            amount: Number(row.amount),
            description: (row.description as string | null) ?? undefined,
          })),
          /*
           * A bill with no due date is still owed. It is dated to its invoice date rather than
           * dropped, which counts it against available cash sooner than reality — the safe
           * direction for a figure the owner decides how much to spend against.
           */
          ...(bills ?? [])
            .filter((row) => (row.status as string | null) !== "VOIDED" && (row.status as string | null) !== "DELETED")
            .map((row) => ({
              dueDate: (row.due_date as string | null) ?? (row.invoice_date as string),
              category: "supplier bill",
              amount: Number(row.amount_due),
              description: (row.contact_name as string | null) ?? undefined,
            })),
        ],
      };
    },
  };
}
