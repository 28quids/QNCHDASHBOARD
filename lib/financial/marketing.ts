import Decimal from "decimal.js";
import { money, ratio, sum } from "./money";
import type { ContributionLevel, DecimalInput } from "./types";

/**
 * QNCH-calculated marketing economics.
 *
 * Platform-attributed figures are reported alongside, never inside, the QNCH figures: a
 * platform's own purchase count is its attribution claim, not QNCH's measured result.
 */

export interface PlatformAttributionInput {
  platform: "meta" | "tiktok";
  spend: DecimalInput;
  attributedPurchases?: number;
  attributedPurchaseValue?: DecimalInput;
}

export interface MarketingPeriodInput {
  netRevenue: DecimalInput;
  /** Net revenue from first orders by customers acquired in the period. */
  newCustomerNetRevenue: DecimalInput;
  /**
   * Contribution those first orders generated before any advertising was deducted, measured
   * at the approved break-even level. This is the money genuinely available to buy a customer.
   */
  newCustomerContributionBeforeAds: DecimalInput;
  newCustomers: number;
  contributionLevel: ContributionLevel;
  platforms: readonly PlatformAttributionInput[];
  /** Acquisition spend that is not attributable to a platform, e.g. affiliate commission. */
  otherAcquisitionSpend?: DecimalInput;
}

export interface PlatformMarketingResult {
  platform: "meta" | "tiktok";
  spend: Decimal;
  attributedPurchases: number | null;
  /** Cost per platform-attributed purchase. Not comparable with blended CAC. */
  attributedCac: Decimal | null;
  attributedRoas: Decimal | null;
}

export interface MarketingPeriodResult {
  advertisingSpend: Decimal;
  /** Marketing efficiency ratio: total net revenue per £1 of advertising. */
  mer: Decimal | null;
  /** Advertising spend per newly acquired customer, measured by QNCH orders. */
  blendedCac: Decimal | null;
  /** New-customer net revenue per £1 of advertising. Reported separately from MER. */
  newCustomerRoas: Decimal | null;
  contributionLevel: ContributionLevel;
  /** Most QNCH can pay for a customer before the first order stops contributing. */
  maximumCac: Decimal | null;
  breakEvenRoas: Decimal | null;
  /** Positive means acquisition has room; negative means QNCH is buying unprofitable orders. */
  cacHeadroom: Decimal | null;
  roasHeadroom: Decimal | null;
  /** Null when there is not enough data to judge, rather than a misleading false. */
  isAcquisitionViable: boolean | null;
  platforms: PlatformMarketingResult[];
}

export function calculateMarketingPeriod(input: MarketingPeriodInput): MarketingPeriodResult {
  const platformSpend = sum(input.platforms.map((platform) => platform.spend));
  const advertisingSpend = platformSpend.plus(input.otherAcquisitionSpend ?? 0);

  const netRevenue = money(input.netRevenue);
  const newCustomerNetRevenue = money(input.newCustomerNetRevenue);

  const mer = ratio(netRevenue, advertisingSpend);
  const blendedCac = input.newCustomers > 0 ? advertisingSpend.div(input.newCustomers) : null;
  const newCustomerRoas = ratio(newCustomerNetRevenue, advertisingSpend);

  const maximumCac =
    input.newCustomers > 0 ? money(input.newCustomerContributionBeforeAds).div(input.newCustomers) : null;
  const averageNewCustomerRevenue = input.newCustomers > 0 ? newCustomerNetRevenue.div(input.newCustomers) : null;
  const breakEvenRoas =
    maximumCac && averageNewCustomerRevenue && !maximumCac.isZero() ? averageNewCustomerRevenue.div(maximumCac) : null;

  const cacHeadroom = maximumCac && blendedCac ? maximumCac.minus(blendedCac) : null;
  const roasHeadroom = mer && breakEvenRoas ? mer.minus(breakEvenRoas) : null;

  return {
    advertisingSpend,
    mer,
    blendedCac,
    newCustomerRoas,
    contributionLevel: input.contributionLevel,
    maximumCac,
    breakEvenRoas,
    cacHeadroom,
    roasHeadroom,
    isAcquisitionViable: cacHeadroom ? cacHeadroom.greaterThanOrEqualTo(0) : null,
    platforms: input.platforms.map(calculatePlatformResult),
  };
}

function calculatePlatformResult(platform: PlatformAttributionInput): PlatformMarketingResult {
  const spend = money(platform.spend);
  const purchases = platform.attributedPurchases ?? null;
  return {
    platform: platform.platform,
    spend,
    attributedPurchases: purchases,
    attributedCac: purchases && purchases > 0 ? spend.div(purchases) : null,
    attributedRoas:
      platform.attributedPurchaseValue === undefined ? null : ratio(platform.attributedPurchaseValue, spend),
  };
}
