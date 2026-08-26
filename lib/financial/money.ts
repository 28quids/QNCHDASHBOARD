import Decimal from "decimal.js";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = Decimal.Value;

export const ZERO = new Decimal(0);

export const money = (value: DecimalInput): Decimal => new Decimal(value);

export const sum = (values: readonly DecimalInput[]): Decimal =>
  values.reduce<Decimal>((total, value) => total.plus(value), ZERO);

/** Returns null rather than Infinity/NaN so callers must handle "not available" explicitly. */
export const ratio = (numerator: DecimalInput, denominator: DecimalInput): Decimal | null => {
  const divisor = money(denominator);
  return divisor.isZero() ? null : money(numerator).div(divisor);
};

/** Rounds to whole pence for presentation and for values written to numeric(19, 4) money columns. */
export const toPence = (value: Decimal): Decimal => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Splits an amount across weights without losing or inventing pennies: the parts always
 * sum back to `total` exactly. Remainders go to the largest fractional parts first, which
 * keeps SKU-level cost allocation reconcilable against the order-level figure.
 */
export function allocateProportionally(total: DecimalInput, weights: readonly DecimalInput[]): Decimal[] {
  const target = toPence(money(total));
  if (weights.length === 0) return [];

  const weightTotal = sum(weights);
  if (weightTotal.isZero()) {
    // No basis to weight by: spread evenly so the total is still fully accounted for.
    return distributeEvenly(target, weights.length);
  }

  const exact = weights.map((weight) => target.times(weight).div(weightTotal));
  const floored = exact.map((value) => value.toDecimalPlaces(2, Decimal.ROUND_DOWN));
  let remainder = target.minus(sum(floored));

  const order = exact
    .map((value, index) => ({ index, fraction: value.minus(floored[index]) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction));

  const penny = new Decimal("0.01");
  const step = remainder.isNegative() ? penny.negated() : penny;
  for (const { index } of order) {
    if (remainder.isZero()) break;
    floored[index] = floored[index].plus(step);
    remainder = remainder.minus(step);
  }

  return floored;
}

function distributeEvenly(target: Decimal, count: number): Decimal[] {
  const base = target.div(count).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: count }, () => base);
  let remainder = target.minus(base.times(count));
  const penny = new Decimal("0.01");
  const step = remainder.isNegative() ? penny.negated() : penny;
  for (let index = 0; index < count && !remainder.isZero(); index += 1) {
    parts[index] = parts[index].plus(step);
    remainder = remainder.minus(step);
  }
  return parts;
}
