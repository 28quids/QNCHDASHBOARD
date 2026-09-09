/**
 * Building the workbook's contents.
 *
 * Pure: it takes a report and returns rows of cells, with no network and no database. That is
 * what makes the export testable at all — the alternative is a function that can only be
 * verified by looking at a real spreadsheet afterwards.
 *
 * The workbook is a **presentation surface, not a second source of truth**. Every figure here
 * comes from the same engine the dashboard reads, and nothing is recomputed in a formula:
 * a spreadsheet that derives CM3 in a cell will eventually disagree with the one that derives
 * it in code, and there is no way to tell which is right from inside the spreadsheet.
 *
 * Numbers are written as numbers rather than as formatted strings. "£1,234" is text, and a
 * column of text sums to nothing — which is the whole reason for exporting to a spreadsheet.
 */

import type Decimal from "decimal.js";
import type { CellValue } from "@/lib/connectors/google/sheets-client";
import type { ControlCentreReport } from "./report";
import { summariseByMonth, type DailyFinancialRow } from "@/lib/financial/daily-aggregation";
import type { InventoryPosition } from "@/lib/financial/inventory";
import type { CashPosition } from "@/lib/financial/cash";
import type { DataQualityResult } from "@/lib/monitoring/data-quality";
import type { ReconciliationStatus } from "@/lib/monitoring/reconciliation";
import type { TargetEvaluation } from "@/lib/monitoring/targets";

/** A decimal as a spreadsheet number, or blank where the figure genuinely does not exist. */
const n = (value: Decimal | null | undefined): CellValue =>
  value === null || value === undefined ? null : value.toNumber();

export interface SheetTab {
  title: string;
  rows: CellValue[][];
}

/**
 * A reconciliation finding as the workbook renders it.
 *
 * Narrower than `ReconciliationResult` on purpose: this is read back out of the database rather
 * than computed here, so it carries only what was stored and does not pretend to the labels and
 * derived rates the in-memory result has.
 */
export interface ReconciliationRow {
  reconciliationKey: string;
  sourceAValue: Decimal | null;
  sourceBValue: Decimal | null;
  difference: Decimal | null;
  status: ReconciliationStatus | string;
}

export interface WorkbookInput {
  report: ControlCentreReport;
  generatedAt: string;
  today: string;
  cash?: CashPosition | null;
  hasReportedBankBalance?: boolean;
  inventory?: readonly InventoryPosition[];
  dataQuality?: readonly DataQualityResult[];
  reconciliation?: readonly ReconciliationRow[];
  targets?: readonly TargetEvaluation[];
}

/**
 * Every tab, in the order the brief numbers them.
 *
 * Numbered so they sort predictably in the tab bar, and so a reader can be told "see 03" rather
 * than "the third one along", which stops being true the moment someone drags a tab.
 */
export function buildWorkbook(input: WorkbookInput): SheetTab[] {
  return [
    { title: "00_DASHBOARD", rows: dashboardTab(input) },
    { title: "02_UNIT_ECONOMICS", rows: unitEconomicsTab(input.report) },
    { title: "03_DAILY_P&L", rows: dailyTab(input.report.daily) },
    { title: "04_MONTHLY_P&L", rows: monthlyTab(input.report.daily) },
    { title: "05_MARKETING", rows: marketingTab(input.report) },
    { title: "08_INVENTORY", rows: inventoryTab(input.inventory ?? []) },
    { title: "09_CASH", rows: cashTab(input) },
    { title: "14_DATA_QUALITY", rows: dataQualityTab(input) },
  ];
}

/** The header every tab carries, so a printed page can never be mistaken for a current one. */
const stamp = (input: WorkbookInput): CellValue[][] => [
  ["QNCH Control Centre", null, "Generated", input.generatedAt],
  ["Period", `${input.report.range.from} to ${input.report.range.to}`, "As at", input.today],
  [],
];

function dashboardTab(input: WorkbookInput): CellValue[][] {
  const { summary, marketing } = input.report;

  const rows: CellValue[][] = [
    ...stamp(input),
    ["Metric", "Value", "Status", "Note"],
    ...metricRow("Net revenue", summary.netRevenue, input),
    ...metricRow("Orders", summary.orders, input, "orders"),
    ...metricRow("AOV", summary.averageOrderValue, input, "average_order_value"),
    ...metricRow("New customers", summary.newCustomers, input),
    [],
    ["CM1", n(summary.cm1), null, n(summary.cm1Margin)],
    ["CM2", n(summary.cm2), null, n(summary.cm2Margin)],
    ["CM3", n(summary.cm3), null, n(summary.cm3Margin)],
    // Blank rather than CM3 relabelled. Operating profit without fixed costs is not profit.
    [
      "Operating profit",
      summary.fixedOperatingCosts.isZero() ? null : n(summary.operatingProfit),
      null,
      summary.fixedOperatingCosts.isZero() ? "no fixed costs configured" : n(summary.operatingMargin),
    ],
    [],
    ["Ad spend", n(marketing.advertisingSpend)],
    ["MER", n(marketing.mer)],
    ["Blended CAC", n(marketing.blendedCac)],
    ["Maximum CAC", n(marketing.maximumCac), null, `measured at ${marketing.contributionLevel.toUpperCase()}`],
    ["CAC headroom", n(marketing.cacHeadroom)],
    ["Break-even ROAS", n(marketing.breakEvenRoas)],
    ["ROAS headroom", n(marketing.roasHeadroom)],
  ];

  if (input.cash && input.hasReportedBankBalance) {
    rows.push(
      [],
      ["Bank balance", n(input.cash.bankBalance)],
      ["Available cash", n(input.cash.availableCash)],
      ["Inventory value", n(input.cash.inventoryValue)],
      ["Runway (days)", n(input.cash.runwayDays)],
    );
  } else {
    rows.push([], ["Bank balance", null, null, "no reported balance — Xero not connected or not synced"]);
  }

  return rows;
}

/** One row, with its target status where a target exists for it. */
function metricRow(
  label: string,
  value: Decimal | number | null,
  input: WorkbookInput,
  metricKey?: string,
): CellValue[][] {
  const evaluation = metricKey
    ? input.targets?.find((target) => target.metricKey === metricKey)
    : undefined;

  return [
    [
      label,
      typeof value === "number" ? value : n(value),
      evaluation?.status ?? null,
      evaluation?.breachedTarget ? evaluation.message : null,
    ],
  ];
}

function unitEconomicsTab(report: ControlCentreReport): CellValue[][] {
  return [
    [
      "SKU",
      "Units",
      "Orders",
      "Gross sales",
      "Discounts",
      "Net revenue",
      "Product COGS",
      "Packaging",
      "Fulfilment",
      "Shipping",
      "Payment fees",
      "Contribution before ads",
      "Contribution margin",
      "Net price per unit",
      "COGS per unit",
      "Contribution per unit",
      "Revenue share",
    ],
    ...report.skus.map((sku) => [
      // Unattributed lines carry revenue and no cost, so they are labelled rather than hidden:
      // dropping them would make the SKU rows silently fail to sum to the P&L.
      sku.sku ?? "(unattributed)",
      sku.unitsSold,
      sku.orders,
      n(sku.grossSales),
      n(sku.discounts),
      n(sku.netRevenue),
      n(sku.costs.productCogs),
      n(sku.costs.packaging),
      n(sku.costs.fulfilment),
      n(sku.costs.shipping),
      n(sku.costs.paymentProcessing),
      n(sku.contributionBeforeAds),
      n(sku.contributionMargin),
      n(sku.perUnit.netSellingPrice),
      n(sku.perUnit.productCogs),
      n(sku.perUnit.contributionBeforeAds),
      n(sku.revenueShare),
    ]),
  ];
}

const DAILY_HEADER: CellValue[] = [
  "Date",
  "Gross sales",
  "Discounts",
  "Shipping",
  "Refunds",
  "Net revenue",
  "CM1",
  "CM1 %",
  "Meta spend",
  "TikTok spend",
  "Other acquisition",
  "Total ad spend",
  "CM2",
  "CM2 %",
  "CM3",
  "CM3 %",
  "Fixed costs",
  "Operating profit",
  "Orders",
  "New customers",
];

const dailyRow = (row: DailyFinancialRow): CellValue[] => [
  row.businessDate,
  n(row.grossSales),
  n(row.discounts),
  n(row.shippingRevenue),
  n(row.refunds),
  n(row.netRevenue),
  n(row.cm1),
  n(row.cm1Margin),
  n(row.metaAdSpend),
  n(row.tiktokAdSpend),
  n(row.otherAcquisitionSpend),
  n(row.advertisingSpend),
  n(row.cm2),
  n(row.cm2Margin),
  n(row.cm3),
  n(row.cm3Margin),
  n(row.fixedOperatingCosts),
  n(row.operatingProfit),
  row.orders,
  row.newCustomers,
];

function dailyTab(daily: readonly DailyFinancialRow[]): CellValue[][] {
  return [DAILY_HEADER, ...daily.map(dailyRow)];
}

/**
 * The same walk by month.
 *
 * Summarised through the engine rather than by summing the daily rows in the sheet, because the
 * margins are ratios of totals and not totals of ratios. A spreadsheet averaging a CM3 % column
 * produces a number that is wrong in a way nobody notices.
 */
function monthlyTab(daily: readonly DailyFinancialRow[]): CellValue[][] {
  const months = summariseByMonth([...daily]);

  return [
    [
      "Month",
      "Gross sales",
      "Discounts",
      "Refunds",
      "Net revenue",
      "CM1",
      "CM1 %",
      "Ad spend",
      "CM2",
      "CM2 %",
      "CM3",
      "CM3 %",
      "Fixed costs",
      "Operating profit",
      "Orders",
      "New customers",
      "AOV",
    ],
    ...[...months].map(([month, summary]) => [
      month,
      n(summary.grossSales),
      n(summary.discounts),
      n(summary.refunds),
      n(summary.netRevenue),
      n(summary.cm1),
      n(summary.cm1Margin),
      n(summary.advertisingSpend),
      n(summary.cm2),
      n(summary.cm2Margin),
      n(summary.cm3),
      n(summary.cm3Margin),
      n(summary.fixedOperatingCosts),
      n(summary.operatingProfit),
      summary.orders,
      summary.newCustomers,
      n(summary.averageOrderValue),
    ]),
  ];
}

function marketingTab(report: ControlCentreReport): CellValue[][] {
  const { marketing } = report;

  return [
    ["QNCH-measured", "Value"],
    ["Advertising spend", n(marketing.advertisingSpend)],
    ["MER", n(marketing.mer)],
    ["Blended CAC", n(marketing.blendedCac)],
    ["New-customer ROAS", n(marketing.newCustomerRoas)],
    ["Maximum CAC", n(marketing.maximumCac)],
    ["Break-even ROAS", n(marketing.breakEvenRoas)],
    ["CAC headroom", n(marketing.cacHeadroom)],
    ["ROAS headroom", n(marketing.roasHeadroom)],
    ["Acquisition viable", marketing.isAcquisitionViable],
    [],
    // Kept in their own block, and labelled as claims. A platform's attributed ROAS is its own
    // measurement of its own performance; putting it beside QNCH's figures without saying so is
    // how a 4x platform ROAS gets read as a 4x business result.
    ["Platform-reported (attribution claims, never used in contribution)", null, null, null],
    ["Platform", "Spend", "Attributed purchases", "Attributed CAC", "Attributed ROAS"],
    ...marketing.platforms.map((platform) => [
      platform.platform,
      n(platform.spend),
      platform.attributedPurchases,
      n(platform.attributedCac),
      n(platform.attributedRoas),
    ]),
  ];
}

function inventoryTab(positions: readonly InventoryPosition[]): CellValue[][] {
  return [
    [
      "SKU",
      "Available units",
      "On order",
      "Sold last 7d",
      "Sold last 30d",
      "Avg daily sales",
      "Days of cover",
      "Reorder point",
      "Lead time (days)",
      "Expected delivery",
      "Needs reorder",
      "Inventory value",
      "Snapshot",
    ],
    ...positions.map((position) => [
      position.sku ?? position.variantId,
      n(position.availableUnits),
      n(position.unitsOnOrder),
      position.unitsSoldLast7Days,
      position.unitsSoldLast30Days,
      n(position.averageDailySales30),
      n(position.daysOfStockRemaining),
      n(position.reorderPointUnits),
      position.supplierLeadTimeDays,
      position.expectedDeliveryDate,
      position.needsReorder,
      // Blank, not zero: a variant with no approved cost has stock of unknown value, which is
      // not the same as stock worth nothing.
      n(position.inventoryValue),
      position.snapshotAt,
    ]),
  ];
}

function cashTab(input: WorkbookInput): CellValue[][] {
  const rows: CellValue[][] = [
    ["Cash is not profit, and stock is not cash. Neither is derived from the other."],
    [],
  ];

  if (!input.cash || !input.hasReportedBankBalance) {
    rows.push(["No bank balance has been reported. Xero is not connected, or not synced."]);
    return rows;
  }

  const cash = input.cash;
  rows.push(
    ["Bank balance", n(cash.bankBalance)],
    ["Committed (inside horizon)", n(cash.committedCash)],
    ["Total commitments", n(cash.totalCommitments)],
    ["Available cash", n(cash.availableCash)],
    ["Inventory value", n(cash.inventoryValue)],
    ["Net cash flow", n(cash.netCashFlow)],
    ["Average daily burn", n(cash.averageDailyBurn)],
    ["Runway (days)", n(cash.runwayDays)],
    ["Projected zero cash", cash.projectedZeroCashDate],
    [],
    ["Upcoming commitments", null, null],
    ["Due", "Category", "Amount", "Description"],
    ...cash.upcomingCommitments.map((commitment) => [
      commitment.dueDate,
      commitment.category,
      Number(commitment.amount),
      commitment.description ?? null,
    ]),
  );

  return rows;
}

function dataQualityTab(input: WorkbookInput): CellValue[][] {
  const rows: CellValue[][] = [
    ["Check", "Status", "Severity", "Message"],
    ...(input.dataQuality ?? []).map((result) => [
      result.checkKey,
      result.status,
      result.severity,
      result.message,
    ]),
    [],
    ["Reconciliation", null, null, null],
    ["Check", "Source A", "Source B", "Difference", "Status"],
    ...(input.reconciliation ?? []).map((result) => [
      result.reconciliationKey,
      n(result.sourceAValue),
      n(result.sourceBValue),
      n(result.difference),
      result.status,
    ]),
    [],
    ["Warnings raised by the engine over this period", null],
    ...input.report.warnings.map((warning) => [warning.code, warning.detail]),
  ];

  return rows;
}

/**
 * The A1 range a tab's rows occupy.
 *
 * The sheet name is quoted because several tabs contain an `&`, which A1 notation treats as
 * significant — `03_DAILY_P&L!A1` is rejected where `'03_DAILY_P&L'!A1` is not.
 */
export function rangeFor(tab: SheetTab): string {
  const width = tab.rows.reduce((widest, row) => Math.max(widest, row.length), 1);
  return `'${tab.title.replace(/'/g, "''")}'!A1:${columnName(width)}${Math.max(tab.rows.length, 1)}`;
}

/** The whole tab, for clearing it before a rewrite. */
export const wholeTabRange = (title: string): string => `'${title.replace(/'/g, "''")}'`;

/** A1 column name: 1 is A, 26 is Z, 27 is AA. */
export function columnName(index: number): string {
  let name = "";
  let remaining = index;

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name || "A";
}

/**
 * Pads every row to the same width.
 *
 * The API writes a ragged row as a short row rather than as a row with blanks, which leaves
 * whatever was in the cells beyond it — so a shorter export would show last night's values in
 * the columns it no longer reaches.
 */
export function rectangular(rows: readonly CellValue[][]): CellValue[][] {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 1);
  return rows.map((row) => [...row, ...Array<CellValue>(width - row.length).fill(null)]);
}
