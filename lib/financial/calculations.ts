import Decimal from "decimal.js";
import { money as amount, ratio, type DecimalInput } from "./money";
import type { BreakEvenInput, BreakEvenResult, DailyFinancialInput, DailyFinancialResult } from "./types";

/** Calculates QNCH management contribution figures from policy-normalised amounts. */
export function calculateDailyFinancials(input: DailyFinancialInput): DailyFinancialResult {
  const netRevenue = amount(input.grossSales)
    .plus(input.shippingRevenue ?? 0)
    .minus(input.discounts)
    .minus(input.refundsAndReturns);
  const cm1 = netRevenue
    .minus(input.productCogs)
    .minus(input.packaging)
    .minus(input.inboundFreight)
    .minus(input.paymentProcessing)
    .minus(input.otherVariableProductCosts);
  const advertisingSpend = amount(input.metaAdSpend).plus(input.tikTokAdSpend).plus(input.otherAcquisitionSpend);
  const cm2 = cm1.minus(advertisingSpend);
  const cm3 = cm2
    .minus(input.fulfilment)
    .minus(input.shipping)
    .minus(input.shopifyAndVariableApps)
    .minus(input.otherVariableOperatingCosts);
  const operatingProfit = cm3.minus(input.fixedOperatingCosts);
  const newCustomers = input.newCustomers ?? 0;

  return {
    netRevenue,
    cm1,
    cm1Margin: ratio(cm1, netRevenue),
    advertisingSpend,
    cm2,
    cm2Margin: ratio(cm2, netRevenue),
    cm3,
    cm3Margin: ratio(cm3, netRevenue),
    operatingProfit,
    operatingMargin: ratio(operatingProfit, netRevenue),
    blendedCac: newCustomers > 0 ? advertisingSpend.div(newCustomers) : null,
    mer: ratio(netRevenue, advertisingSpend),
  };
}
/**
 * Break-even metrics are available only after finance explicitly supplies the selected
 * contribution amount and the eligible customer basis. They are never inferred from ROAS.
 */
export function calculateBreakEvenEconomics(input: BreakEvenInput): BreakEvenResult {
  if (input.eligibleNewCustomers <= 0) {
    return { contributionLevel: input.contributionLevel, maximumCac: null, breakEvenRoas: null };
  }

  const maximumCac = amount(input.approvedContribution).div(input.eligibleNewCustomers);
  return {
    contributionLevel: input.contributionLevel,
    maximumCac,
    breakEvenRoas: ratio(amount(input.averageNewCustomerNetRevenue), maximumCac),
  };
}

export function calculateInventoryDays(availableUnits: DecimalInput, averageDailyUnitsSold: DecimalInput): Decimal | null {
  return ratio(amount(availableUnits), amount(averageDailyUnitsSold));
}
