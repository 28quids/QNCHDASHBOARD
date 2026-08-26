# QNCH financial-policy decision register

This register controls live financial calculations. Until every required item is approved in the database, `business_settings.financial_policy_status` remains `draft` and the dashboard must not present official profit figures.

| # | Decision needed from QNCH | Recommended starting position (not yet implemented) | Why it matters |
|---|---|---|---|
| 1 | **VAT basis:** Should management revenue, margin and costs be VAT-exclusive? Which VAT/tax categories need separate reporting? | VAT-exclusive P&L and contribution metrics; VAT remains an explicit cash/tax commitment. | Prevents VAT from inflating margin and profit. |
| 2 | **Revenue:** Include shipping charged to customers in gross/net revenue? How are gift cards, store credit, cancellations and chargebacks treated? | Merchandise and shipping shown separately; recognise gift-card sales according to finance policy. | Changes revenue, AOV and contribution. |
| 3 | **Refund/return timing:** Recognise against original order date or processed refund date? | Refund processed date, with original-order traceability. | Determines daily/monthly P&L comparability. |
| 4 | **Costing method:** Standard or actual landed COGS? How should inbound freight, bundles, samples and stock adjustments be allocated? | Approved, date-effective landed standard cost per SKU, reviewed on each replenishment. | Determines CM1 and inventory value. |
| 5 | **CM category map:** Confirm every line that belongs in CM1, CM2, CM3 or fixed operating expense. | Meta/TikTok media in CM2; fulfilment, carrier shipping and variable Shopify/apps in CM3; agency fee treatment explicitly chosen. | Avoids moving costs between margins without audit. |
| 6 | **New customer:** Is a Shopify customer ID with their first paid, non-test order the definition? What is the treatment of guest checkout merges and refunded first orders? | First paid order by a resolved Shopify customer ID; retain a configurable exclusion for cancelled/test orders. | Drives blended CAC, cohorts and repeat rate. |
| 7 | **Break-even definition:** Should maximum CAC be based on CM1 or CM3, and should it be per first order/SKU or blended? | CM3-based and first-order/customer basis, reported alongside a SKU view. | Sets the profitability guardrail for acquisition. |
| 8 | **Advertising:** Which Xero accounts are media spend, and are agency/creative/affiliate costs acquisition spend? Confirm reporting timezone and comparison attribution window. | Platform daily spend in account timezone; separate labelled platform attribution; Xero mapping is the accounting reconciliation source. | Changes CM2, CAC, MER and reconciliation. |
| 9 | **Cash:** List included Xero bank accounts and define available cash, committed cash, Shopify payout timing, VAT/tax, AP and purchase-order treatment. | Reconciled bank balance + explicitly dated commitments; do not use accounting profit as cash. | Determines cash runway and alerts. |
| 10 | **Inventory:** Confirm source of record, locations, units-on-order ownership, reorder thresholds and whether 7- or 30-day sales are the alert basis. | Shopify inventory by location; show both 7- and 30-day run rates, alert on the approved one. | Determines stock-risk alerts. |

## Response format

Reply with the row numbers and the selected policy, for example: `1 VAT-exclusive; 3 processed refund date; 7 CM3/first-order`. “Use the recommended starting position” is also sufficient for a row.

## Access still required for implementation

The configured Supabase URL and browser publishable key permit client wiring only. Applying migrations and running protected sync workers requires a Supabase database connection/CLI login or a suitable deployment workflow, plus server-only `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENCRYPTION_KEY`, and `CRON_SECRET` values. Provider secrets should be added to hosting secret management—not pasted into chat or committed.
