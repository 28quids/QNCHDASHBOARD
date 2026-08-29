# QNCH financial engine

How the implemented calculation layer works. Every module is a pure function over explicit
inputs: nothing reads the database, and nothing decides policy. Connectors normalise raw
provider payloads into these inputs; the database stores the results.

## The contribution walk

```
Gross sales + customer shipping − discounts − refunds        = Net revenue
Net revenue − COGS − packaging − inbound freight
            − payment processing − other variable product    = CM1
CM1 − Meta − TikTok − other acquisition spend                = CM2
CM2 − fulfilment − shipping − Shopify/apps − other variable  = CM3
CM3 − fixed operating costs                                  = Operating profit
```

Amounts are VAT-exclusive and dated in the organisation timezone before they reach the engine.

## Where each cost comes from

Costs have exactly two sources, and both are configurable without a code change.

| Source | Table | Used for |
|---|---|---|
| Per-unit variant costs | `variant_cost_profiles` | Standard landed cost per SKU: COGS, packaging, inbound freight |
| Order, percentage and recurring costs | `cost_assumptions` | Shipping per order, payment processing as a percentage, fulfilment, Shopify fees, salaries, software |

`cost_assumptions.amount` is currency for `per_order`, `per_unit` and `fixed_period`, and a
**percentage** for `percentage_of_revenue` (`1.75` means 1.75%). `fixed_period` requires a
`period_unit`.

An assumption is reported against a named P&L line when its `assumption_key` matches a known
one (`payment_processing`, `outbound_shipping`, `fulfilment`, `shopify_fees`, …). Any other key
is reported in the "other variable" line for its approved bucket, so a new cost added in
settings appears in the P&L rather than disappearing.

**Avoiding double counting.** A per-unit column and an order-level assumption covering the same
cost will both be charged. Leave the variant column at zero when an assumption covers the cost.
When mapped Xero actuals and an assumption hit the same line on the same day, the engine reports
both and raises a `duplicated_cost_source` warning — it does not silently pick one.

## Properties the engine guarantees

- **Costs allocate without losing pennies.** Order-level costs are split across lines by net
  revenue using largest-remainder allocation, so SKU contribution always sums back to the order.
- **Recurring costs sum to the approved amount.** £310 a month spread over a 28-day February
  totals exactly £310. Plain division does not — this is tested.
- **Every date in a range gets a row**, so a gap in the data reads as zero on the chart only
  because it genuinely is zero, and missing dates are raised as a data-quality failure.
- **Unavailable is never healthy.** Ratios with a zero denominator return `null`, and a metric
  with no value evaluates to `unavailable`, never `green`.
- **Nothing is forced to match.** Reconciliation reports differences with a tolerance and a
  status; it never adjusts a figure to close a gap.

## Deliberate omissions

- **No per-SKU CM2 or CM3.** QNCH does not attribute media spend to a SKU, so a per-SKU figure
  after advertising would be an invented allocation. SKU reporting stops at contribution before
  advertising.
- **No predictive LTV.** Cohorts report realised revenue only, and mark a window incomplete when
  it has not elapsed for the whole cohort, so a young cohort is not misread as underperforming.
- **No default for refund cost reversal.** See item 11 of the decision register; the engine
  requires it as an input.

## Module map

| Module | Responsibility |
|---|---|
| `lib/financial/money.ts` | Decimal helpers, penny-exact allocation |
| `lib/financial/dates.ts` | Business-date conversion, ranges, period comparison |
| `lib/financial/effective-dating.ts` | Resolving the assumption in force on a date |
| `lib/financial/cost-resolution.ts` | Variant costs and assumptions for a date |
| `lib/financial/allocation.ts` | Orders and lines into cost components |
| `lib/financial/daily-aggregation.ts` | The daily and monthly contribution walk |
| `lib/financial/marketing.ts` | MER, CAC, break-even, headroom, platform attribution |
| `lib/financial/unit-economics.ts` | SKU-level contribution |
| `lib/financial/customers.ts` | New vs returning, realised cohorts |
| `lib/financial/inventory.ts` | Cover, reorder, stock value |
| `lib/financial/cash.ts` | Balance, commitments, burn, runway |
| `lib/monitoring/targets.ts` | Configured thresholds into green/amber/red |
| `lib/monitoring/data-quality.ts` | Freshness, coverage, mapping checks |
| `lib/monitoring/reconciliation.ts` | Cross-source differences |

## Persistence

The engine stays pure. Everything that touches the database lives outside it.

| Module | Responsibility |
|---|---|
| `lib/connectors/supabase-sync-store.ts` | Run claiming, cursors and outcomes for `runSync` |
| `lib/repositories/shopify-repository.ts` | Normalised Shopify data into rows |
| `lib/connectors/shopify/sync.ts` | Builds the runnable order sync from the three parts |
| `lib/reporting/reporting-repository.ts` | Stored rows back into engine inputs |
| `lib/reporting/report.ts` | Composes one consistent set of facts into every figure |
| `lib/reporting/persist.ts` | Publishes a calculated period, versioned |
| `lib/reporting/calculate.ts` | The job shared by the cron route and the script |

**Business dates are computed in TypeScript, not SQL.** PostgREST cannot express
`at time zone`, so the reporting layer fetches a UTC window padded by a day and filters on the
business date. Filtering on UTC alone would move a 00:30 BST order into the previous day.

**Refunds pull their original order in, even from outside the range.** Reversing the cost of a
refunded unit needs the cost profile in force on the *original* order date, so those orders are
loaded explicitly. They produce no rows of their own — only dates in the range are emitted — so
they add cost basis without adding revenue.

**An unapproved policy is not a zero.** `loadPolicy` returns the specific outstanding decisions
rather than falling back to a default, and the dashboard shows them instead of figures. With no
approved costs every contribution line would equal revenue, which reads as profit.

**Two shapes per order, not one.** `normaliseOrder` produces the engine's VAT-exclusive
inputs and drops what the calculation does not need — the timestamp, the currency, the tax
it stripped, the financial status. The tables store source facts and need those back, so the
repository maps the raw node alongside the normalised figures. Writing the business date into
`ordered_at` would silently shift rows for any non-UTC timezone.

**Acquisition is decided against stored history.** `shopify_customers.first_order_at` is what
stops a sync of a recent window from reading a returning customer's order as their first and
inflating new-customer counts and CAC. It only ever moves backwards, because a backfill pages
by `updatedAt` and a customer's true first order can arrive in any page.

**Unresolved variants are reported, not invented.** Orders usually sync before products. A
variant row requires a product, so fabricating one from an order line would put a fake row in
the catalogue. Lines keep their SKU with a null `variant_id`, and the count is returned so
incomplete SKU reporting is visible rather than silent.
