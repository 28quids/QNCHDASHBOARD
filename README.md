# QNCH Control Centre

Internal business intelligence and financial-control system for QNCH. Supabase/Postgres is the canonical historical data store; Google Sheets and the Next.js dashboard are presentation surfaces.

## Current foundation

- Next.js application shell
- Supabase migration for core data, audit and sync structures
- Decimal-based management financial calculations with automated tests
- Secret-safe environment template and ignore rules

The initial migration deliberately marks the financial policy as `draft`. Approved policy values are then recorded as date-effective, auditable settings before live financial reporting is enabled.

## Local setup

1. Copy `.env.example` to `.env.local` and populate only local development credentials.
2. Run `npm install --legacy-peer-deps`. Plain `npm install` fails on the current peer tree.
3. Apply the database migrations — see below.
4. Seed the organisation: `node scripts/seed-organisation.mjs`.
5. Run `npm test`, then `npm run dev`.

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
node scripts/register-shopify-connection.mts
```

It verifies the token against the Admin API, warns on any currency or timezone disagreement
with the organisation, stores the token encrypted, and reports whether orders older than 60
days are readable. `read_orders` alone only exposes the last 60 days: without `read_all_orders`
a historical backfill appears to succeed and silently returns nothing older.

## Guardrails

- Never commit `.env`, service-account files, OAuth tokens, PII exports or financial credentials.
- Treat raw provider payloads as restricted; dashboard users should access derived, RLS-protected reporting views only.
- Re-runnable syncs must upsert by provider external ID and record a `sync_runs.job_key`.
- A production dashboard must show freshness/failed sync state and never coerce reconciliation differences to zero.
