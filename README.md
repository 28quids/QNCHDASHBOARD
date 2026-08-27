# QNCH Control Centre

Internal business intelligence and financial-control system for QNCH. Supabase/Postgres is the canonical historical data store; Google Sheets and the Next.js dashboard are presentation surfaces.

## What is built

| Area | State |
|---|---|
| Supabase schema, RLS, migrations | Complete |
| Financial engine (CM1/CM2/CM3, CAC, MER, break-even, cohorts, inventory, cash) | Complete, pure functions |
| Shopify connector | Complete, backfilled |
| Reporting layer — database to engine to published figures | Complete |
| Dashboard, authentication, nightly cron | Complete |
| Meta, TikTok, Xero connectors | Not built — credentials outstanding |
| Google Sheets export | Not built — service account outstanding |

The engine is pure: nothing in `lib/financial` reads the database or decides policy. Connectors
write source facts, `lib/reporting` shapes them into engine inputs, and the dashboard presents
the result. See `docs/financial-engine.md`.

## Local setup

1. Copy `.env.example` to `.env.local` and populate only local development credentials.
2. Run `npm install --legacy-peer-deps`. Plain `npm install` fails on the current peer tree.
3. Apply the database migrations — see below.
4. Seed the organisation: `node scripts/seed-organisation.mjs`, and put the printed
   `ORGANISATION_ID` into `.env.local`.
5. Connect Shopify and backfill — see below.
6. Record the approved financial policy: `npm run seed:policy`.
7. Grant yourself dashboard access: `npm run grant:access -- you@example.com`.
8. Run `npm test`, then `npm run dev`.

Steps 6 and 7 are not optional. Until the policy is approved the dashboard shows the
outstanding decisions instead of figures, and until access is granted every query returns
nothing — row-level security, not a bug.

## Database migrations

`SUPABASE_DB_URL` in `.env.local` holds the session-pooler connection string. It is used
only by the scripts below; the application talks to Supabase over PostgREST.

```
npm run migrate:status          # what is applied and what is pending
npm run migrate                 # apply everything pending, in filename order
node scripts/verify-schema.mjs  # inspect the database itself, independent of the above
node scripts/diagnose-db.mjs    # work out why a connection is being refused
```

Applied migrations are recorded in `public.schema_migrations`. Each migration commits
together with its bookkeeping row, so one can never be marked applied unless it was.

Migration files also carry their own `begin;`/`commit;`, so they remain safe to paste into
the Supabase SQL editor if the direct connection is unavailable. The runner strips that
wrapper and supplies its own, covering both the migration and its bookkeeping row.

`migrate:status` reports what the runner *recorded*. `verify-schema` inspects the database
itself and will disagree if the two ever drift — worth running after any manual change.

`node scripts/show-tenant.mjs` reports the organisation, its policy settings, its provider
connections and current row counts, and checks that `ORGANISATION_ID` resolves to a real row.

## Connecting Shopify

Create a custom app in the Shopify admin (Settings → Apps and sales channels → Develop apps),
grant it `read_orders`, `read_all_orders`, `read_products`, `read_inventory`, `read_locations`,
`read_customers` and `read_shopify_payments_payouts`, install it, then put the **Admin API
access token** — the value beginning `shpat_`, not the `shpss_` API secret key — into
`.env.local` along with the `myshopify.com` host.

```
npm run shopify:connect
```

It verifies the token against the Admin API, warns on any currency or timezone disagreement
with the organisation, stores the token encrypted, and reports whether orders older than 60
days are readable. `read_orders` alone only exposes the last 60 days: without `read_all_orders`
a historical backfill appears to succeed and silently returns nothing older.

Then backfill, starting with a dry run that writes nothing:

```
npm run probe:shopify -- --timeline      # scopes, catalogue, orders by month
npm run backfill:shopify -- --dry-run    # fetch one page, write nothing
npm run backfill:shopify -- --created-since 2026-01-01
```

The backfill syncs the product catalogue first, then orders. That order matters: order lines
resolve their variant against `product_variants`, so running orders into an empty catalogue
writes every line unattributed — and because the order job key would then be recorded as
succeeded, a corrective re-run would be skipped rather than fixing it.

Use `--created-since` to bound a backfill to a period of trading, and `--since` for an
incremental run. They filter different fields: `created_at` bounds a window, `updated_at`
catches orders edited later, such as one refunded weeks after it was placed.

Scripts that import application code run through `tsx`. The library uses extensionless
imports and the `@/` alias — bundler-style resolution that Node's own ESM resolver does not
implement, and whose strip-only TypeScript mode also rejects parameter properties.

## Financial policy and costs

`npm run seed:policy` records the thirteen decisions of the register as approved, writes the
per-unit landed cost and the cost assumptions, and only then flips
`business_settings.financial_policy_status` to `approved` — all in one transaction, so the
status can never claim approval without the costs behind it.

Costs are dated from the first order in the data rather than from today, so the whole trading
history is costed on one approved basis instead of being restated against a cost nobody had
agreed at the time.

```
npm run seed:policy -- --dry-run   # print what would be written
npm run seed:policy                # apply
```

## Calculating

```
npm run calculate -- --dry-run                        # figures only, writes nothing
npm run calculate -- --from 2026-01-01 --to 2026-08-26
npm run calculate                                     # last 30 days, publishes
```

The dashboard **calculates on read**, so it always reflects the costs approved now — a
corrected COGS shows immediately rather than after the next job. `daily_financials` is a
separate, versioned record of what was *published* at the time, for restatement audit and the
Sheets export. The data-quality page shows both so a divergence is visible.

Publishing swaps a period atomically through `public.replace_daily_financials`. Superseded
rows are retained rather than deleted; exactly one row per date is ever current.

## Dashboard access

Authentication uses Supabase Auth. The tokens are held in httpOnly cookies and replayed as a
bearer token on every server-side query, so dashboard reads execute **as the signed-in user**
and RLS is the real access boundary rather than an application check that could be forgotten.
The service-role client is reserved for connector workers and the cron job.

Signing up grants nothing on its own — every read policy checks `organisation_members`:

```
npm run grant:access -- you@example.com          # owner
npm run grant:access -- someone@example.com viewer
npm run grant:access -- --list
```

## Scheduled refresh

`POST` or `GET` `/api/cron/daily`, authenticated with `CRON_SECRET` as a bearer token. Vercel
Cron is configured in `vercel.json` for 03:00 daily and supplies that header automatically.

It republishes a trailing 45-day window rather than only yesterday: a refund processed today
lands on today, but an order edited in Shopify changes a past day, and a restated cost changes
every day it applies to. Recomputing one day would leave those corrections unpublished.

## Guardrails

- Never commit `.env`, service-account files, OAuth tokens, PII exports or financial credentials.
- Treat raw provider payloads as restricted; dashboard users should access derived, RLS-protected reporting views only.
- Re-runnable syncs must upsert by provider external ID and record a `sync_runs.job_key`.
- A production dashboard must show freshness/failed sync state and never coerce reconciliation differences to zero.
