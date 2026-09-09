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
| Targets, alerts and health status | Complete |
| Custom reporting, saved reports, CSV export | Complete |
| Reconciliation and data-quality history | Complete |
| Meta connector | Complete |
| TikTok Ads connector | Complete — credentials outstanding |
| Xero connector | Complete — credentials outstanding |
| Google Sheets export | Complete — service account outstanding |

The engine is pure: nothing in `lib/financial` reads the database or decides policy. Connectors
write source facts, `lib/reporting` shapes them into engine inputs, and the dashboard presents
the result. See `docs/financial-engine.md`.

## Local setup

1. Create `.env.local` with the variables below.
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

Then, in whatever order the credentials arrive:

9. Connect Meta, TikTok and Xero, and backfill each.
10. Map the Xero chart of accounts: `npm run map:xero -- --suggest`, then `--set` each one you
    agree with. Until an account is mapped its spend moves cash and appears nowhere in the P&L.
11. Set the thresholds the dashboard judges against: `npm run seed:targets -- --metrics`, then
    `--set` each. Until then the dashboard reports "no targets configured" rather than green.
12. Record supplier lead times: `npm run seed:inventory -- --lead-time 28`. Without one no
    reorder alert can fire.

Steps 10 to 12 are what turn a set of imported figures into a control centre. Each one is a
business decision the system deliberately refuses to make on QNCH's behalf.

## Environment variables

There is deliberately no committed `.env.example`. Every `.env*` file is ignored without
exception, so nothing in the repository can hold a value that looks like real configuration.
The list below is the template.

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API. Public; ships to the browser. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same page. Public by design; RLS is the boundary, not this key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, `service_role`. **Bypasses RLS** — server-side only. |
| `SUPABASE_DB_URL` | Supabase → Connect → Session pooler. Used only by the scripts, never by the app. Percent-encode `@ : / ?` in the password. |
| `ORGANISATION_ID` | Printed by `node scripts/seed-organisation.mjs`. Every table is keyed on it. |
| `TOKEN_ENCRYPTION_KEY` | Generate 32 random bytes, base64. Encrypts provider tokens at rest — if lost, every stored token must be reconnected. |
| `CRON_SECRET` | Generate 32 random bytes. Bearer token for `/api/cron/daily`. |
| `SHOPIFY_SHOP_DOMAIN` | The `myshopify.com` host, no scheme and no trailing slash. |
| `SHOPIFY_ADMIN_TOKEN` | Admin API access token, begins `shpat_`. Not the `shpss_` secret key, and shown only once. |
| `META_ACCESS_TOKEN` | Meta system user token. Not a user token — see below. |
| `META_AD_ACCOUNT_ID` | The `act_...` identifier of the ad account. |
| `TIKTOK_ACCESS_TOKEN` | TikTok developer portal, after an advertiser authorises the app. |
| `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` | The app the token was issued for. Used only to list advertisers; never stored. |
| `TIKTOK_ADVERTISER_ID` | The numeric advertiser id. `npm run tiktok:connect -- --list` prints the ones the token can reach. |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | The Xero app, from developer.xero.com. These identify QNCH's application, not the organisation. |
| `XERO_REDIRECT_URI` | Optional. Defaults to `http://localhost:5478/callback`, which must be registered on the app. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The service account, from its JSON key file. |
| `GOOGLE_PRIVATE_KEY` | The `private_key` value from the same file, BEGIN and END lines included. |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The id in the workbook's URL, between `/d/` and `/edit`. |

The Google variables are optional. Without them the nightly job skips the export rather than
reporting a failure: an organisation that has not set up Sheets is not in an error state.

`lib/env.ts` validates the server set at startup with zod, so a missing or malformed value
fails immediately rather than surfacing as an empty dashboard later.

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

Re-running a window that already succeeded is a no-op, which is what makes a retried cron
safe. Pass `--force` to re-read it anyway after a connector fix — orders upsert on their
Shopify id, so it restates rather than duplicates.

Every run checks that each order's gross, discounts, shipping and tax add back to the total
Shopify charged, and reports the orders that do not. That identity is what catches a money
field being read from the wrong place while each figure still looks plausible alone.
`npm run reconcile:shopify` runs the same check against everything already stored.

Scripts that import application code run through `tsx`. The library uses extensionless
imports and the `@/` alias — bundler-style resolution that Node's own ESM resolver does not
implement, and whose strip-only TypeScript mode also rejects parameter properties.

## Connecting Meta

Use a **system user token**, not a user token. A user token expires every 60 days and breaks
whenever the person who issued it loses access to the business portfolio; a system user token
belongs to the business and does not expire.

Business settings → Users → System users → your user → Generate new token, selecting your app
and ticking `ads_read`. Then assign the *ad account* to that system user under Assign assets —
assigning the app is a separate step, and both are required.

```
npm run meta:connect -- --list       # ad accounts this token can reach
npm run meta:connect                 # register META_AD_ACCOUNT_ID
npm run backfill:meta -- --dry-run   # fetch one page, write nothing
npm run backfill:meta -- --since 2026-01-01
```

An empty account list has two quite different causes that look identical — a missing
`ads_read` scope, or the scope without an assigned ad account — so `meta:connect` asks Meta
which scopes were actually granted and says which of the two it is.

## Connecting TikTok

Create an app in the TikTok for Business developer portal, generate the authorisation URL,
open it as a user with access to the advertiser account, and approve it. That produces an
access token. Put the token, the app id and the app secret into `.env.local`.

```
npm run tiktok:connect -- --list     # advertisers this token can reach
npm run tiktok:connect               # register TIKTOK_ADVERTISER_ID
npm run backfill:tiktok -- --dry-run # fetch one page, write nothing
npm run backfill:tiktok -- --since 2026-01-01
```

The app id and secret are needed because TikTok scopes the advertiser listing to the app
rather than to the token alone. Neither is stored — only the token is, encrypted.

Authorising the *app* is not the same as being assigned to the *advertiser*. Both are needed,
and an account that has done only the first lists no advertisers at all; `--list` is what
separates that from a bad token.

**Which conversion metrics exist depends on the advertiser's optimisation goal and pixel**,
and TikTok fails the whole request if one is unknown. The connector therefore requests the
full set, and on a rejection retries once with the delivery metrics alone, reporting what it
had to drop. Spend and impressions import either way; the conversion columns are left empty
rather than being invented, and the untouched row is kept in `raw_metrics`.

A metric that is meaningless under the query — conversions across ad groups optimising for
different goals, say — comes back as the string `-`. That is stored as null, not zero: TikTok
not measuring something is a different fact from it measuring none.

Like Meta, the last week is re-imported on every run, because conversions continue to settle
after TikTok's reporting latency. The upsert makes that converge rather than accumulate.

## Connecting Xero

Xero is the only provider here that needs a human in a browser. There is no equivalent of a
system user token, so someone with access to the organisation consents once.

Create an app at developer.xero.com, choose **Web app**, and register
`http://localhost:5478/callback` as a redirect URI. Put the client id and secret into
`.env.local`, then:

```
npm run xero:connect                  # prints the URL, waits for the redirect
npm run xero:connect -- --status      # what is connected, and when its token expires
npm run backfill:xero -- --dry-run    # read the chart of accounts, write nothing
npm run backfill:xero -- --since 2026-01-01
npm run map:xero -- --suggest         # then --set each account you agree with
```

### The refresh token is single use

This is the one thing about Xero that will bite if it is not understood. **Every refresh
invalidates the token that was used** and issues a new one. The connector persists the rotated
value before the access token is handed to anything, and a failure to store it fails the sync
rather than being logged and stepped over — because a rotation that only exists in memory ends
with a connection nobody can explain the loss of.

Two consequences follow:

- **Restoring an old database backup restores a spent token.** The connection has to be made
  again. That is Xero's design, not a fault here.
- **Sixty days without a sync expires the refresh token.** The connection is marked
  `needs_reauth` and the data-quality page says so; `npm run xero:connect` fixes it.

### Mapping accounts

Until an account is mapped to a contribution bucket its spend is imported and then ignored: it
moves cash and appears nowhere in the P&L. That default is deliberate. Guessing which bucket a
cost belongs in does not produce an obviously wrong number, it produces a plausible CM2 that is
quietly incorrect — so `map:xero --suggest` proposes and a human decides.

Unmapping end-dates the rule rather than deleting it, so a past period keeps the basis it was
calculated on instead of history silently changing.

### What is read at which grain

A single card payment can be split across several expense accounts. The transaction header
carries the total, which is what the cash model needs; the **lines** carry the accounts, which
is what the contribution walk reads. Charging a split payment entirely to whichever account
came first would put real money in the wrong bucket, so it does not happen.

The bank balance is the closing balance **Xero itself reports**, from its Bank Summary, and not
a running total of imported movements. Those differ whenever an import is partial, and the
running total reads exactly like a balance while being neither reconciled nor complete. Where
no reported balance exists the cash page says so rather than showing a figure.

Unpaid supplier bills are read as cash commitments. They are money owed and not yet paid —
neither cash nor cost — which is why they sit beside the balance rather than inside it.

Dates arrive .NET-serialised as `/Date(1476316800000+0000)/` and are converted through the
business timezone, so a payment made late on the 1st is not reported on the 31st.

## Targets and alerts

The dashboard's GREEN / AMBER / RED status comes entirely from `metric_targets`. No threshold
is written in code, so nothing in this repository decides what "good" looks like for QNCH.

```
npm run seed:targets -- --metrics                    # what can be targeted
npm run seed:targets -- --set cm3_margin 15 --severity red
npm run seed:targets -- --set blended_cac 22
npm run seed:targets -- --list
npm run seed:targets -- --unset cm3_margin
```

**Ratio metrics are given as percentages.** `--set cm3_margin 15` means 15% and is stored as
0.15. The two differ by a hundredfold and both look plausible in a table, so the conversion
happens in the script rather than in someone's head.

The comparison is derived from the metric rather than supplied: a target on CAC is always a
ceiling, one on margin always a floor. Letting either be stated by hand is an opportunity to
get one backwards, and a backwards target fires constantly or never.

Three behaviours are deliberate and worth knowing:

- **No targets configured reads as "no targets", not as green.** A dashboard reporting perfect
  health because nothing was ever measured is worse than one admitting it is not judging.
- **A metric that could not be calculated reads as unavailable, not as met.** Operating margin
  with no fixed costs configured is not a margin, and cash with no reported bank balance is not
  zero cash.
- **Unsetting end-dates the target rather than deleting it**, so restating a past period is
  judged against the threshold that was in force at the time.

Every key that can be targeted is listed in `lib/monitoring/metric-catalogue.ts`, which is the
same catalogue the observation builder reads. A test asserts the two agree — a target stored
against a key nothing evaluates would never fire, which looks exactly like one always met.

## Custom reporting

`/reports` composes a report from the same metric catalogue the targets use: tick the metrics,
pick a window and a grain, run it. The whole specification lives in the query string, so a
report is a shareable link, and the CSV route parses those same parameters rather than
reimplementing the calculation — an export cannot disagree with the screen it came from.

```
/reports?metric=net_revenue&metric=cm3_margin&grain=month&timeframe=ytd
/reports?metric=blended_cac&grain=week&from=2026-01-01&to=2026-06-30
```

**Every bucket is computed by running the engine over that bucket**, not by aggregating the
dashboard's figures. Most of these metrics do not sum: a month's CAC is not the sum of its days'
CACs, and MER is a ratio of two totals rather than a total of ratios. Adding them up produces
numbers that look right and are not.

A saved report stores the *question*, never the figures, and recomputes on open — so it reflects
the costs approved now rather than a snapshot from when it was saved. It holds either a named
timeframe, which keeps moving with today, or a fixed pair of dates, which does not; carrying
both would leave which one wins to whoever read it next, so exactly one is required.

Three things the table is careful about:

- **A dash is not a zero.** No acquisitions means no CAC; no revenue means no margin.
- **A clipped bucket is labelled by its dates**, not as the whole month, so a part-month is
  never shown as though it were comparable with the full ones beside it.
- **Cash and stock read as unavailable**, because they are positions at an instant rather than
  activity over a window. They are shown live on their own pages instead.

The CSV writes values unformatted. A spreadsheet has to read them as numbers, and `£1,234` and
`42.0%` are text — a column of those sums to nothing.

## Reconciliation

Independent sources are compared on every refresh and the findings are stored, so a discrepancy
has a history rather than only a current moment. Nothing here nudges a figure towards agreement:
a difference is recorded as a difference, and a source that cannot be read is recorded as *not
applicable* rather than as zero. "The two agree" and "one of them is missing" must never look
the same.

| Check | Compares |
|---|---|
| `revenue.shopify_payouts` | What customers were charged against what the processor settled |
| `ad_spend.meta` / `ad_spend.tiktok` | A platform's reported spend against the money that left the bank |
| `ad_spend.total` | All platform spend against all Xero advertising |
| `cash.bank_balance` | The balance QNCH's movements imply against the one Xero reports |

Three details decide whether these are meaningful rather than noise:

- **The revenue check compares gross figures on both sides.** The order total including VAT and
  shipping, against the payout's charges less refunds — not its net, which has fees taken out.
  Comparing a VAT-exclusive management figure with a bank figure would report the VAT as a
  discrepancy in every period, and comparing against net would report the processor's fee.
- **The tolerance is proportional, not fixed.** A £50 gap on £500 is a problem and the same gap
  on £50,000 is a Tuesday. It defaults to 2% of the larger side.
- **The window is 30 days.** Settlements lag orders and advertising is billed in arrears, so a
  shorter window is mostly timing difference and would report a finding every night.

Per-platform advertising needs the chart of accounts to dedicate an account to each platform:

```
npm run map:xero -- --set 400 acquisition --platform meta
```

Left unset, only the total is reconciled — which is still worth knowing. Attributing a shared
"Advertising" account to one platform by reading its name would be a guess presented as a fact.

A reconciliation failure never fails the refresh. The numbers still imported, and the finding is
the point; suppressing it because the run succeeded is how a discrepancy goes unnoticed for a
quarter.

Shopify payouts are synced for this and for nothing else. A payout is money arriving days after
the orders that produced it, so reading it as revenue would report the same sale twice on two
different dates. The summary breakdown is requested best-effort — a GraphQL field absent from
the shop's API version fails the whole query — and falls back to a document carrying only the
net amount, which is the figure the check actually needs.

## Google Sheets

The workbook is a **presentation surface, not a second source of truth**. Supabase holds the
canonical history and this writes a readable copy of it. Nothing is ever read back, so a stray
edit in the spreadsheet can confuse a reader but can never reach the financial model.

1. Google Cloud console → create a service account → create a JSON key.
2. Enable the Google Sheets API for that project.
3. **Share the spreadsheet with the service account's email address, as an Editor.** This step
   is invisible from the Cloud console and is the usual cause of a 403.
4. Put the three variables above into `.env.local`.

```
npm run export:sheets -- --dry-run    # build the tabs, write nothing
npm run export:sheets
npm run export:sheets -- --from 2026-01-01 --to 2026-08-31
```

Tabs written: `00_DASHBOARD`, `02_UNIT_ECONOMICS`, `03_DAILY_P&L`, `04_MONTHLY_P&L`,
`05_MARKETING`, `08_INVENTORY`, `09_CASH`, `14_DATA_QUALITY`. Missing tabs are created; existing
ones are cleared before rewriting, so a shorter export cannot leave last night's rows underneath
this one looking like current data.

Four decisions worth knowing:

- **No formulas.** Every figure comes from the engine. A spreadsheet that derives CM3 in a cell
  will eventually disagree with the code that derives it, and there is no way to tell which is
  right from inside the spreadsheet.
- **Numbers are written as numbers**, not as `£1,234`. A column of formatted text sums to
  nothing, which defeats the point of exporting to a spreadsheet at all.
- **Values are written raw**, not interpreted. Under Sheets' `USER_ENTERED` mode a SKU like
  `-ORANGE` becomes a formula error and a code like `1-2` becomes a date.
- **Tabs are protected with a warning, not a lock.** The risk is an accidental overtype, not a
  malicious one, and a hard lock would shut the owner out of their own workbook. The protection
  is added once per tab rather than on every run, or a nightly export would stack another one
  every night.

The export runs at the end of the nightly refresh and can never fail it: the canonical data is
already in Supabase, and a copy that could not be written must not discard the import behind it.

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

## Deploying to Vercel

Supabase is already hosted, so only the Next.js application needs deploying.

1. Push this repository to GitHub, then **vercel.com → Add New → Project** and import it.
2. Set the build command override to `npm install --legacy-peer-deps && npm run build`. The
   default `npm install` fails on the current peer tree.
3. Add every variable from the table above as an **Environment Variable**, for Production.
   `SUPABASE_DB_URL` is not needed — it is only used by the local migration scripts.
4. Deploy. The cron in `vercel.json` runs `/api/cron/daily` at 03:00 UTC and Vercel supplies
   the `CRON_SECRET` bearer token automatically.

Nothing needs to change in Supabase: the deployment connects to the same project the local
environment does, so the data is the same data.

### Giving someone else access

Two steps, and both are required — the first alone grants nothing.

1. **Supabase → Authentication → Users → Add user**, with their email. Tick *Auto Confirm*,
   or they cannot sign in however correct their password is.
2. `npm run grant:access -- them@example.com viewer`

Roles: `owner` and `finance_admin` may edit costs, targets and policy; `operator` and `viewer`
read only. Membership is what every row-level security policy checks, so an account without it
signs in successfully and sees nothing.

Then `npm run set:password -- them@example.com`, or let them use the Supabase password-reset
email.

## Scheduled refresh

`POST` or `GET` `/api/cron/daily`, authenticated with `CRON_SECRET` as a bearer token. Vercel
Cron is configured in `vercel.json` for 03:00 daily and supplies that header automatically.

It **fetches from every connected provider and then recalculates** — Shopify catalogue and
orders, Meta hierarchy and insights, TikTok hierarchy and reports, the Xero ledger and bank
balance, then the contribution walk, the reconciliation checks and the Sheets export. The same pipeline is behind
the **Refresh now** button on the data-quality page, so a manual refresh and the nightly one
cannot drift apart.

Providers run in sequence and one failing does not stop the others: Meta being down must not
prevent Shopify orders importing. A run where any provider failed reports `partial`, never
`ok`, and the per-provider outcome is shown rather than collapsed into a single tick.

It republishes a trailing 45-day window rather than only yesterday: a refund processed today
lands on today, but an order edited in Shopify changes a past day, and a restated cost changes
every day it applies to. Recomputing one day would leave those corrections unpublished.

Meta and TikTok are re-fetched over a trailing week on every run, because both restate
conversions for several days as attribution settles. The upsert makes that converge rather
than accumulate.

## Inventory settings

```
npm run seed:inventory -- --lead-time 28    # supplier lead time, all variants
npm run seed:inventory -- --list
```

Without a lead time no reorder alert can fire. A variant is flagged when its days of cover
fall to or below the lead time — the point at which ordering today still beats the stockout.
A fixed reorder point in units is optional and off by default, because the lead-time rule
adapts to how fast a SKU is actually selling and a unit threshold does not.

## Guardrails

- Never commit `.env`, service-account files, OAuth tokens, PII exports or financial credentials.
- Xero refresh tokens are single use and rotate on every sync. Restoring an old database backup
  restores a spent token, and the connection has to be made again.
- Treat raw provider payloads as restricted; dashboard users should access derived, RLS-protected reporting views only.
- Re-runnable syncs must upsert by provider external ID and record a `sync_runs.job_key`.
- A production dashboard must show freshness/failed sync state and never coerce reconciliation differences to zero.
