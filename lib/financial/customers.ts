import Decimal from "decimal.js";
import { contributionBeforeAds, type AllocatedOrder } from "./allocation";
import { addDays, monthKey, type DateRange } from "./dates";
import { sum } from "./money";
import type { ContributionLevel } from "./types";

/**
 * Customer economics measured from QNCH orders.
 *
 * V1 reports realised revenue only. No predictive lifetime value is modelled, because a
 * projected LTV would be an assumption presented next to measured figures.
 */

export interface CustomerPeriodSummary {
  orders: number;
  returningOrders: number;
  distinctCustomers: number;
  newCustomers: number;
  netRevenue: Decimal;
  newCustomerNetRevenue: Decimal;
  returningCustomerNetRevenue: Decimal;
  averageOrderValue: Decimal | null;
  newCustomerAverageOrderValue: Decimal | null;
  ordersPerCustomer: Decimal | null;
  /** Share of orders in the period placed by an already-acquired customer. */
  repeatOrderShare: Decimal | null;
  /** Share of customers active in the period who ordered more than once within it. */
  repeatCustomerRate: Decimal | null;
}

export function summariseCustomers(orders: readonly AllocatedOrder[]): CustomerPeriodSummary {
  const newOrders = orders.filter((order) => order.isNewCustomerOrder);
  const returningOrders = orders.filter((order) => !order.isNewCustomerOrder);

  const ordersPerCustomerId = new Map<string, number>();
  for (const order of orders) {
    if (!order.customerId) continue;
    ordersPerCustomerId.set(order.customerId, (ordersPerCustomerId.get(order.customerId) ?? 0) + 1);
  }

  const netRevenue = sum(orders.map((order) => order.netRevenue));
  const newCustomerNetRevenue = sum(newOrders.map((order) => order.netRevenue));
  const distinctCustomers = ordersPerCustomerId.size;
  const repeatCustomers = [...ordersPerCustomerId.values()].filter((count) => count > 1).length;

  return {
    orders: orders.length,
    returningOrders: returningOrders.length,
    distinctCustomers,
    newCustomers: newOrders.length,
    netRevenue,
    newCustomerNetRevenue,
    returningCustomerNetRevenue: sum(returningOrders.map((order) => order.netRevenue)),
    averageOrderValue: orders.length > 0 ? netRevenue.div(orders.length) : null,
    newCustomerAverageOrderValue: newOrders.length > 0 ? newCustomerNetRevenue.div(newOrders.length) : null,
    ordersPerCustomer: distinctCustomers > 0 ? new Decimal(orders.length).div(distinctCustomers) : null,
    repeatOrderShare: orders.length > 0 ? new Decimal(returningOrders.length).div(orders.length) : null,
    repeatCustomerRate: distinctCustomers > 0 ? new Decimal(repeatCustomers).div(distinctCustomers) : null,
  };
}

/** The acquisition inputs the marketing model needs, measured from first orders only. */
export function summariseAcquisition(orders: readonly AllocatedOrder[], level: ContributionLevel) {
  const firstOrders = orders.filter((order) => order.isNewCustomerOrder);
  return {
    newCustomers: firstOrders.length,
    newCustomerNetRevenue: sum(firstOrders.map((order) => order.netRevenue)),
    newCustomerContributionBeforeAds: sum(firstOrders.map((order) => contributionBeforeAds(order, level))),
  };
}

export interface CohortWindowRevenue {
  days: number;
  revenue: Decimal;
  /** False when the window has not fully elapsed for every customer in the cohort. */
  isComplete: boolean;
}

export interface CustomerCohort {
  cohortMonth: string;
  customers: number;
  firstOrderRevenue: Decimal;
  windows: CohortWindowRevenue[];
  revenuePerCustomer: Decimal | null;
}

export const DEFAULT_COHORT_WINDOWS = [30, 60, 90, 180] as const;

/**
 * Realised revenue by acquisition month.
 *
 * A window is marked incomplete when `asOf` has not yet reached the window end for every
 * customer in the cohort, so a young cohort is never read as underperforming when it has
 * simply not had time to repeat.
 */
export function buildCustomerCohorts(
  orders: readonly AllocatedOrder[],
  asOf: string,
  windows: readonly number[] = DEFAULT_COHORT_WINDOWS,
): CustomerCohort[] {
  const firstOrderDates = new Map<string, string>();
  for (const order of orders) {
    if (!order.customerId) continue;
    const existing = firstOrderDates.get(order.customerId);
    if (!existing || order.businessDate < existing) firstOrderDates.set(order.customerId, order.businessDate);
  }

  const cohorts = new Map<string, { customers: Set<string>; latestFirstOrder: string }>();
  for (const [customerId, firstDate] of firstOrderDates) {
    const month = monthKey(firstDate);
    const cohort = cohorts.get(month) ?? { customers: new Set<string>(), latestFirstOrder: firstDate };
    cohort.customers.add(customerId);
    if (firstDate > cohort.latestFirstOrder) cohort.latestFirstOrder = firstDate;
    cohorts.set(month, cohort);
  }

  return [...cohorts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortMonth, cohort]) => {
      const cohortOrders = orders.filter((order) => order.customerId && cohort.customers.has(order.customerId));
      const revenuePerWindow = windows.map((days) => ({
        days,
        revenue: sum(
          cohortOrders
            .filter((order) => {
              const firstDate = firstOrderDates.get(order.customerId as string) as string;
              return order.businessDate <= addDays(firstDate, days);
            })
            .map((order) => order.netRevenue),
        ),
        isComplete: addDays(cohort.latestFirstOrder, days) <= asOf,
      }));

      const customers = cohort.customers.size;
      const firstOrderRevenue = sum(
        cohortOrders
          .filter((order) => order.businessDate === firstOrderDates.get(order.customerId as string))
          .map((order) => order.netRevenue),
      );
      const totalRevenue = sum(cohortOrders.map((order) => order.netRevenue));

      return {
        cohortMonth,
        customers,
        firstOrderRevenue,
        windows: revenuePerWindow,
        revenuePerCustomer: customers > 0 ? totalRevenue.div(customers) : null,
      };
    });
}

/** Restricts orders to a reporting window before summarising. */
export function ordersInRange(orders: readonly AllocatedOrder[], range: DateRange): AllocatedOrder[] {
  return orders.filter((order) => order.businessDate >= range.from && order.businessDate <= range.to);
}
