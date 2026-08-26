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
2. Run `npm install`.
3. Apply `supabase/migrations/0001_foundation.sql` to a local/staging Supabase project.
4. Run `npm test`, then `npm run dev`.

## Guardrails

- Never commit `.env`, service-account files, OAuth tokens, PII exports or financial credentials.
- Treat raw provider payloads as restricted; dashboard users should access derived, RLS-protected reporting views only.
- Re-runnable syncs must upsert by provider external ID and record a `sync_runs.job_key`.
- A production dashboard must show freshness/failed sync state and never coerce reconciliation differences to zero.
