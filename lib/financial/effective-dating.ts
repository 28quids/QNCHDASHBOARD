/**
 * Every management assumption in QNCH is date-effective so that restating a past period
 * uses the cost that was approved at the time, not today's cost.
 *
 * Dates are compared as `YYYY-MM-DD` strings, which sorts correctly and avoids introducing
 * a timezone during comparison. Callers resolve a business date first.
 */

export interface EffectiveDated {
  effectiveFrom: string;
  effectiveTo?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertBusinessDate(value: string): string {
  if (!ISO_DATE.test(value)) {
    throw new Error(`Expected a YYYY-MM-DD business date, received "${value}"`);
  }
  return value;
}

export function isEffectiveOn(record: EffectiveDated, businessDate: string): boolean {
  if (record.effectiveFrom > businessDate) return false;
  return !record.effectiveTo || record.effectiveTo >= businessDate;
}

/** All records in force on the date. Used where several assumptions legitimately stack. */
export function resolveAllEffective<T extends EffectiveDated>(records: readonly T[], businessDate: string): T[] {
  assertBusinessDate(businessDate);
  return records.filter((record) => isEffectiveOn(record, businessDate));
}

/**
 * The single record in force on the date, taking the latest `effectiveFrom` when overlapping
 * versions exist. Returns null instead of guessing when nothing has been approved yet.
 */
export function resolveEffective<T extends EffectiveDated>(records: readonly T[], businessDate: string): T | null {
  const candidates = resolveAllEffective(records, businessDate);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, record) => (record.effectiveFrom > latest.effectiveFrom ? record : latest));
}

/** Groups records by a key, then resolves each group independently. */
export function resolveEffectiveByKey<T extends EffectiveDated>(
  records: readonly T[],
  businessDate: string,
  keyOf: (record: T) => string,
): Map<string, T> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(record);
    else grouped.set(key, [record]);
  }

  const resolved = new Map<string, T>();
  for (const [key, group] of grouped) {
    const match = resolveEffective(group, businessDate);
    if (match) resolved.set(key, match);
  }
  return resolved;
}
