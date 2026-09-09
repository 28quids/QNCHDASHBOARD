/**
 * The metrics a target can be set against.
 *
 * One catalogue, read by both the observation builder and the seeding script, so a target can
 * never be stored against a key nothing evaluates. A typo would otherwise be silent: the target
 * would sit in the table, match no observation, and simply never fire — which looks exactly
 * like a metric that is within target.
 *
 * `direction` states which way is good, so the seeding script does not have to be told the
 * comparison for each metric and cannot get one backwards. `basis` states what the number is,
 * because a margin stored as 35 rather than 0.35 is off by a hundredfold and still plausible.
 */

export type MetricDirection = "higher_is_better" | "lower_is_better";
export type MetricBasis = "currency" | "ratio" | "count" | "days";

export interface MetricDefinition {
  key: string;
  label: string;
  direction: MetricDirection;
  basis: MetricBasis;
  description: string;
}

export const METRIC_CATALOGUE: readonly MetricDefinition[] = [
  {
    key: "net_revenue",
    label: "Net revenue",
    direction: "higher_is_better",
    basis: "currency",
    description: "Gross sales less discounts and refunds, for the selected period.",
  },
  {
    key: "average_order_value",
    label: "AOV",
    direction: "higher_is_better",
    basis: "currency",
    description: "Net revenue per order.",
  },
  {
    key: "refund_rate",
    label: "Refund rate",
    direction: "lower_is_better",
    basis: "ratio",
    description: "Refunds as a share of gross sales.",
  },
  {
    key: "cm1_margin",
    label: "CM1 margin",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Contribution after product costs, as a share of net revenue.",
  },
  {
    key: "cm2_margin",
    label: "CM2 margin",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Contribution after advertising, as a share of net revenue.",
  },
  {
    key: "cm3_margin",
    label: "CM3 margin",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Contribution after variable operating costs, as a share of net revenue.",
  },
  {
    key: "operating_margin",
    label: "Operating margin",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Operating profit as a share of net revenue. Unavailable until fixed costs are configured.",
  },
  {
    key: "blended_cac",
    label: "Blended CAC",
    direction: "lower_is_better",
    basis: "currency",
    description: "Total advertising spend per newly acquired customer, measured by QNCH orders.",
  },
  {
    key: "mer",
    label: "MER",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Net revenue per pound of advertising.",
  },
  {
    key: "cac_headroom",
    label: "CAC headroom",
    direction: "higher_is_better",
    basis: "currency",
    description: "Maximum CAC less actual CAC. Negative means QNCH is buying unprofitable orders.",
  },
  {
    key: "roas_headroom",
    label: "ROAS headroom",
    direction: "higher_is_better",
    basis: "ratio",
    description: "MER less break-even ROAS.",
  },
  {
    key: "meta_cac",
    label: "Meta CAC",
    direction: "lower_is_better",
    basis: "currency",
    description: "Meta spend per Meta-attributed purchase. Not comparable with blended CAC.",
  },
  {
    key: "tiktok_cac",
    label: "TikTok CAC",
    direction: "lower_is_better",
    basis: "currency",
    description: "TikTok spend per TikTok-attributed purchase. Not comparable with blended CAC.",
  },
  {
    key: "meta_roas",
    label: "Meta ROAS",
    direction: "higher_is_better",
    basis: "ratio",
    description: "Meta's own attributed return. A platform claim, never QNCH's measured result.",
  },
  {
    key: "tiktok_roas",
    label: "TikTok ROAS",
    direction: "higher_is_better",
    basis: "ratio",
    description: "TikTok's own attributed return. A platform claim, never QNCH's measured result.",
  },
  {
    key: "cash_balance",
    label: "Bank balance",
    direction: "higher_is_better",
    basis: "currency",
    description: "The balance Xero reports. Unavailable until Xero is connected and synced.",
  },
  {
    key: "available_cash",
    label: "Available cash",
    direction: "higher_is_better",
    basis: "currency",
    description: "Bank balance less commitments falling due inside the horizon.",
  },
  {
    key: "cash_runway_days",
    label: "Cash runway",
    direction: "higher_is_better",
    basis: "days",
    description: "Days of available cash at the measured burn rate. Unavailable when cash is growing.",
  },
  {
    key: "minimum_inventory_days",
    label: "Lowest stock cover",
    direction: "higher_is_better",
    basis: "days",
    description: "Days of cover on the SKU closest to running out.",
  },
] as const;

const BY_KEY = new Map(METRIC_CATALOGUE.map((metric) => [metric.key, metric]));

export const metricDefinition = (key: string): MetricDefinition | undefined => BY_KEY.get(key);

export const isKnownMetric = (key: string): boolean => BY_KEY.has(key);

/** The comparison a target on this metric must use, derived rather than restated. */
export const comparisonFor = (metric: MetricDefinition): "gte" | "lte" =>
  metric.direction === "higher_is_better" ? "gte" : "lte";
