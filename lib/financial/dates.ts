import { assertBusinessDate } from "./effective-dating";

/**
 * QNCH reports on business dates in the organisation timezone, not UTC. An order placed at
 * 00:30 BST belongs to that London day; treating it as UTC would move revenue between days
 * and break daily reconciliation against Shopify.
 */

export function toBusinessDate(instant: Date | string, timeZone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot derive a business date from "${String(instant)}"`);
  }
  // en-CA renders as YYYY-MM-DD, and the timeZone option applies the correct DST offset.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(businessDate: string, days: number): string {
  assertBusinessDate(businessDate);
  const [year, month, day] = businessDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  assertBusinessDate(from);
  assertBusinessDate(to);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Every date in an inclusive range, so days with no activity are still reported as zero. */
export function enumerateDates(from: string, to: string): string[] {
  const length = daysBetween(from, to);
  if (length < 0) return [];
  return Array.from({ length: length + 1 }, (_, offset) => addDays(from, offset));
}

export const monthKey = (businessDate: string): string => businessDate.slice(0, 7);

export interface DateRange {
  from: string;
  to: string;
}

export function rangeEndingOn(to: string, days: number): DateRange {
  return { from: addDays(to, -(days - 1)), to };
}

export function monthToDate(to: string): DateRange {
  return { from: `${monthKey(to)}-01`, to };
}

export function previousMonth(to: string): DateRange {
  const [year, month] = to.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const end = new Date(Date.UTC(year, month - 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function yearToDate(to: string): DateRange {
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

/** The equivalent window immediately before `range`, for period-on-period comparison. */
export function precedingRange(range: DateRange): DateRange {
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

export function sameRangeLastYear(range: DateRange): DateRange {
  return { from: shiftYear(range.from, -1), to: shiftYear(range.to, -1) };
}

function shiftYear(businessDate: string, years: number): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  // Clamp 29 February onto 28 February in a non-leap year rather than rolling into March.
  const target = new Date(Date.UTC(year + years, month - 1, 1));
  const lastDay = new Date(Date.UTC(year + years, month, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
