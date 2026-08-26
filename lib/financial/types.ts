import Decimal from "decimal.js";

export type ContributionLevel = "cm1" | "cm3";
export type DecimalInput = Decimal.Value;

/**
 * Inputs have already been normalised to the finance-approved VAT and timing policy.
 * The calculation engine deliberately does not decide those policies itself.
 */
export interface DailyFinancialInput {
  grossSales: DecimalInput;
  discounts: DecimalInput;
  refundsAndReturns: DecimalInput;
  productCogs: DecimalInput;
  packaging: DecimalInput;
  inboundFreight: DecimalInput;
  paymentProcessing: DecimalInput;
  otherVariableProductCosts: DecimalInput;
  metaAdSpend: DecimalInput;
  tikTokAdSpend: DecimalInput;
  otherAcquisitionSpend: DecimalInput;
  fulfilment: DecimalInput;
  shipping: DecimalInput;
  shopifyAndVariableApps: DecimalInput;
  otherVariableOperatingCosts: DecimalInput;
  fixedOperatingCosts: DecimalInput;
  newCustomers?: number;
  totalOrders?: number;
}
export interface DailyFinancialResult {
  netRevenue: Decimal;
  cm1: Decimal;
  cm1Margin: Decimal | null;
  advertisingSpend: Decimal;
  cm2: Decimal;
  cm2Margin: Decimal | null;
  cm3: Decimal;
  cm3Margin: Decimal | null;
  operatingProfit: Decimal;
  operatingMargin: Decimal | null;
  blendedCac: Decimal | null;
  mer: Decimal | null;
}

export interface BreakEvenInput {
  approvedContribution: DecimalInput;
  eligibleNewCustomers: number;
  averageNewCustomerNetRevenue: DecimalInput;
  contributionLevel: ContributionLevel;
}

export interface BreakEvenResult {
  contributionLevel: ContributionLevel;
  maximumCac: Decimal | null;
  breakEvenRoas: Decimal | null;
}
