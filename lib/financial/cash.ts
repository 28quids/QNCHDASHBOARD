import Decimal from "decimal.js";
import { addDays, daysBetween, type DateRange } from "./dates";
import { money, sum, ZERO, type DecimalInput } from "./money";

/**
 * The cash reality layer.
 *
 * Everything here comes from bank movements and dated commitments. Operating profit is never
 * used as a proxy for cash, and stock value is never counted as available cash.
 */

export interface CashMovement {
  businessDate: string;
  /** Signed: positive for money received, negative for money paid out. */
  amount: DecimalInput;
  category?: string;
}

export interface CashCommitment {
  dueDate: string;
  category: string;
  amount: DecimalInput;
  description?: string;
}

export interface CashPositionInput {
  asOf: string;
  /** Reconciled bank balance from the connected Xero bank account. */
  bankBalance: DecimalInput;
  commitments: readonly CashCommitment[];
  movements: readonly CashMovement[];
  /** Commitments falling due within this many days count against available cash. */
  commitmentHorizonDays: number;
  /** Window of actual bank movements used to measure the burn rate. */
  burnWindowDays: number;
  /** Stock value, reported alongside cash for context. Never added to it. */
  inventoryValue?: DecimalInput | null;
}

export interface CashPosition {
  asOf: string;
  bankBalance: Decimal;
  /** Commitments due inside the horizon. */
  committedCash: Decimal;
  totalCommitments: Decimal;
  /** Bank balance less near-term commitments. Can legitimately be negative. */
  availableCash: Decimal;
  inventoryValue: Decimal | null;
  netCashFlow: Decimal;
  /** Average daily net outflow over the burn window. Null when cash grew or data is absent. */
  averageDailyBurn: Decimal | null;
  /** Days of available cash at the measured burn rate. Null when QNCH is not burning cash. */
  runwayDays: Decimal | null;
  /** The date available cash reaches zero at the current burn rate. */
  projectedZeroCashDate: string | null;
  burnWindow: DateRange;
  upcomingCommitments: CashCommitment[];
}

export function buildCashPosition(input: CashPositionInput): CashPosition {
  const bankBalance = money(input.bankBalance);
  const horizonEnd = addDays(input.asOf, input.commitmentHorizonDays);

  const upcomingCommitments = input.commitments
    .filter((commitment) => commitment.dueDate >= input.asOf && commitment.dueDate <= horizonEnd)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const committedCash = sum(upcomingCommitments.map((commitment) => commitment.amount));
  const availableCash = bankBalance.minus(committedCash);

  const burnWindow: DateRange = { from: addDays(input.asOf, -(input.burnWindowDays - 1)), to: input.asOf };
  const windowMovements = input.movements.filter(
    (movement) => movement.businessDate >= burnWindow.from && movement.businessDate <= burnWindow.to,
  );
  const netCashFlow = sum(windowMovements.map((movement) => movement.amount));

  // Only a net outflow produces a runway. A cash-positive period has no burn rate to divide by.
  const averageDailyBurn = netCashFlow.isNegative() ? netCashFlow.negated().div(input.burnWindowDays) : null;
  const runwayDays =
    averageDailyBurn && availableCash.greaterThan(0) ? availableCash.div(averageDailyBurn) : averageDailyBurn ? ZERO : null;

  return {
    asOf: input.asOf,
    bankBalance,
    committedCash,
    totalCommitments: sum(input.commitments.map((commitment) => commitment.amount)),
    availableCash,
    inventoryValue: input.inventoryValue == null ? null : money(input.inventoryValue),
    netCashFlow,
    averageDailyBurn,
    runwayDays,
    projectedZeroCashDate: runwayDays ? addDays(input.asOf, Math.floor(runwayDays.toNumber())) : null,
    burnWindow,
    upcomingCommitments: [...upcomingCommitments],
  };
}

/** Groups bank movements into a daily series for the cash chart. */
export function dailyCashFlow(movements: readonly CashMovement[], range: DateRange): Map<string, Decimal> {
  const byDate = new Map<string, Decimal>();
  for (const movement of movements) {
    if (movement.businessDate < range.from || movement.businessDate > range.to) continue;
    byDate.set(movement.businessDate, (byDate.get(movement.businessDate) ?? ZERO).plus(movement.amount));
  }
  return byDate;
}

/** Running balance over a range, working forward from a known opening balance. */
export function cashBalanceSeries(
  openingBalance: DecimalInput,
  movements: readonly CashMovement[],
  range: DateRange,
): { businessDate: string; balance: Decimal }[] {
  const flows = dailyCashFlow(movements, range);
  let balance = money(openingBalance);
  const length = daysBetween(range.from, range.to);
  if (length < 0) return [];

  return Array.from({ length: length + 1 }, (_, offset) => {
    const businessDate = addDays(range.from, offset);
    balance = balance.plus(flows.get(businessDate) ?? ZERO);
    return { businessDate, balance };
  });
}

/** Commitments grouped by category, for the cash page breakdown. */
export function commitmentsByCategory(commitments: readonly CashCommitment[]): Map<string, Decimal> {
  const byCategory = new Map<string, Decimal>();
  for (const commitment of commitments) {
    byCategory.set(commitment.category, (byCategory.get(commitment.category) ?? ZERO).plus(commitment.amount));
  }
  return byCategory;
}
