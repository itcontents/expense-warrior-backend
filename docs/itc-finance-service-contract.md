# Expense Warrior ↔ ITC Finance Service Contract

> **Current source contract and release status — refreshed 2026-10-22:** The owner-approved V1 collection targets are `REVENUE`, `CUSTOMER_CREDIT`, and full-balance settlement of eligible delivered credit invoices. ITC `production` contains implementation commit `a933998` and documentation refresh `3eaf5f8`; the code is committed locally, not pushed or deployed. `preflightCollection` intentionally excludes A/R because exclusive reservation is the pre-provider gate. The separate global `COMMERCE_CREDIT_INVOICES_ENABLED` gate defaults off; new collection-refund creation/submission also requires `EXPENSE_WARRIOR_COLLECTION_REFUNDS_ENABLED`, which defaults off. In-flight provider verification, accounting replay checks, and verified refund completion continue with the gates disabled. Fresh read-only `codex_db.js local_staging` checks show source-matching checksums for migrations 134, 135, 140, 142, 143, and 145–149; 134/135/140/142 are `VERIFIED_ADOPTION`, and 143/145–149 are `APPLIED`. Accounts 1100 and 2020 are active/postable on this local target. This does not establish readiness on `itc`, online staging, production, or a deployed application. Expense Warrior's dedicated migrator role connects to its local database; 0001–0012 match source checksums, while 0013–0017 remain pending. Local provider/ITC finance flags are off and required ITC service credentials, provider-account identity/version, service-key map, and Treasury account mapping are absent. No migration, provider call, or live financial operation was performed. See the [credit-invoice A/R plan](../docs/superpowers/plans/2026-10-20-credit-invoice-ar-reactivation.md) and [shared ITC handoff](../../docs/itc-expense-warrior-shared-handoff.md).

## Database ownership and migration commands

Expense Warrior migrations target only the standalone Expense Warrior database. The operator workflow is documented in [the Expense Warrior migration runbook](database-migrations.md). It must not connect to, apply, or adopt rows in an ITC database. ITC schema changes and verified adoption remain owned by `itcstore-backend`; inspect ITC `itc`, `local_staging`, or staging only through `node scripts/codex_db.js <local_staging|itc|staging> < query.sql` with its dedicated read-only reader, and use ITC's owner-controlled migration release/adoption commands for writes. Do not use `shopit_dba` or `*_ADMIN_DB_*` credentials. The app's status/plan output and migration confirmation flag do not authorize ITC writes.

**Historical status snapshot — 2026-10-20 (superseded by the current status above):** The owner reported manually applying ITC migration SQL 134–135. The read-only audit at that time found A/R schema objects in `local_staging` and `itc`, but no migration-ledger rows 134–145 in either; migration 146 was source-only. The current target-specific migration rows and remaining gates are recorded in the notice above. Schema presence alone does not prove source checksums or ledger provenance. Current source routes implement balance, reserve, release, consume, revenue/customer-credit collection, receivable lookup/reservation/release, and `AR_SETTLEMENT` posting; admin credit-quote conversion creates an unpaid `CREDIT` order and reserves stock without recording payment. A/R is recognized at dispatch. Finance calls remain disabled by default. Revenue/customer-credit and A/R posting paths write Treasury, a balanced journal, and immutable operation/subledger records in one transaction. Account 2020 is the dedicated customer-credit liability; account 2000 remains paid-order advances. Signed, read-only PawaPay sandbox configuration and balance GETs were performed; no deposit, payout, refund, ITC financial post, or migration apply was performed.

### Database verification (2026-10-15)

The owner reported that migrations 134 and 135 were applied to `itc` and `local_staging`. Read-only verification used `scripts/codex_db.js`, which asserts the connected database and audit-role identity, runs one SELECT inside a read-only transaction, and limits results.

- `itc`: PostgreSQL catalogs contain `commerce_schema_migrations` and all expected tables from migrations 134–135: `expense_warrior_finance_operations`, `expense_warrior_fund_holds`, `expense_warrior_service_nonces`, `expense_warrior_collection_operations`, and `expense_warrior_customer_credit_entries`. Direct ledger reads fail with `permission denied for schema public` for the configured `shopit_accounting_audit` role, so the migration names, checksums, and statuses could not be verified there.
- `local_staging`: the same expected tables are present. Account 2020 is `Customer Credit Payable`, active and postable. Accounts 1020 and 1100 were also inspected; 1100 `Trade Receivables` is currently inactive and non-postable. Queries for migration 134/135 or Expense Warrior entries in `commerce_schema_migrations` returned no rows.
- The guarded manifest currently expects SHA-256 `7fca968c587ad8524ce12e261dd16725ad28f2d96ba2a2b4d44f6d4225622a2a` for migration 134 and `2759465bcbaf5246fdd8f4408eabb59d23b5d91a572eeee4f0f00ad9d8be003e` for migration 135. The current schema objects alone do not prove these exact checksums were recorded as applied.
- No database writes, migration commands, provider calls, or financial postings were performed during this verification. Do not enable finance calls until an authorized read-only role can verify the migration ledger/checksums in both targets and the separate account/provider/readiness gates are satisfied.

## Implementation status

- ITC now has additive source for Expense Warrior operation, hold, and HMAC nonce tables, plus a guarded migration release gate.
- Treasury ledger outflows, transfers, and existing PawaPay payout spendability checks count active Expense Warrior holds after migration 134 is applied.
- The ITC HMAC verifier binds exact request bytes and path, checks a five-minute timestamp window, and claims nonces through a restricted database function. The feature remains disabled by default.
- ITC has source-only atomic reserve, release, consume, and collection-posting methods; Expense Warrior has a signed client for balance, category and revenue catalogs, customer lookup/credit balance, reserve, release, consume, collections, and operation lookup. Consume posts the mapped OPEX category, Treasury debit, and balanced journal with its hold resolution. Collection posting supports account-mapped revenue and customer credit, with Treasury, balanced journal, immutable operation evidence, and the customer-credit subledger written atomically. Provider transaction identity is unique per provider; request retries use the same idempotency key and fingerprint. Migration 140 allows new immutable reserve/release operations after a prior hold is released, while preserving one active hold, one release per hold, and one consume per request. It is required by Expense Warrior's approved staff payout retry flow and remains source-only. Final approval/payout orchestration and collection remain disabled until migration application is confirmed from the ledger and an authorized end-to-end readiness review is completed.
- A new read-only `GET /api/v1/internal/expense-warrior/customers?search=&limit=&offset=` route is source-complete for the admin link workflow. It is covered by the signed service middleware and returns only active non-vendor customer IDs, display names, optional company names, and phone last-four values; email and full phone are search-only and are never returned. Expense Warrior exposes it at `GET /api/v1/expense-warrior/admin/payment-links/customers` to authenticated admins. Both sides bound search and pagination. These routes do not provide receivable balances or authorize any posting.
- A signed read-only `GET /api/v1/internal/expense-warrior/revenue-accounts` route now returns only active, postable `REVENUE` COA account codes and names. Expense Warrior validates the response and exposes it only to authenticated admins at `GET /api/v1/expense-warrior/admin/payment-links/revenue-accounts`. This catalog is for explicit link-level mapping; it does not choose an account or authorize a posting.
- Payment-link collection targets are `REVENUE` (with an explicitly selected postable ITC revenue account) and `CUSTOMER_CREDIT` (with a validated standalone customer account). ITC requires the target and all verified provider evidence in the signed POST body. Revenue collections credit the selected revenue account; customer-credit collections credit account 2020 and append a customer balance event. The balance is derived from the immutable customer-credit entries and is distinct from Trade Receivables.
- ITC exposes signed `POST /api/v1/internal/expense-warrior/collections/revenue` and `/collections/customer-credits`, plus `GET /customers/:customer_id/customer-credit`. Revenue and customer-credit posting are atomic with Treasury, journal, operation, and customer-credit evidence. Receivable lookup/reservation/release and `AR_SETTLEMENT` posting endpoints are implemented in production source; admin credit-quote conversion is also implemented in source with additive migration 146, which remains unapplied.
- ITC exposes signed, read-only balance and keyset-paginated ledger-history endpoints for the mapped treasury. Balance serializes with reserve/outflow locks, sums active mobile-money payout and Expense Warrior holds, and returns posted, held, and available ZMW values. History is ordered newest-first by `(created_at, treasury_ledger_id)`, bounded to 500 rows per page, filters a half-open timestamp range, and omits free-text notes and payment references. Expense Warrior proxies admin access and generates bounded audited CSV/XLSX/PDF exports. These paths remain behind the disabled-by-default finance service flag and depend on migration 134's nonce/finance objects. A fresh read-only check resolves the expected migration 134–135 objects in `local_staging`, but no 134–140 ledger rows are present. The approved reader cannot access schema `public` in `itc`, so its objects and ledger state remain unverified.
- Expense Warrior callback intake verifies the raw PawaPay signed request before JSON parsing, enforces a 64 KiB body bound and single-record shape, then appends only provider code, transaction type/ID, status, payload hash, and signature metadata. Exact-body retries are deduplicated. Migration 0008 is applied only in local development; the callback feature flag defaults off. Callbacks are hints only: no attempt state, approval, hold, provider balance, or ITC ledger operation is changed by intake.
- Admin payment-link collection reporting is served from Expense Warrior's own attempt store; it does not query ITC or initiate financial operations. It includes all attempt states, provider references, and only payer last-four digits, with bounded CSV/XLSX/PDF generation and an export audit record. Expense Warrior migration 0016 adds a global created-at index for the date-window query; it is source-only and uses a transactional index build, so deployment must account for write-lock duration.

## Ownership

- ITC is authoritative for treasury accounts, posted ledger entries, available funds, and active holds.
- Expense Warrior owns request workflow, provider attempts, and a reconciliation mirror containing ITC operation/hold references and last-known state only.
- Expense Warrior never connects to the ITC database and never calculates spendable funds from a cached balance.
- The existing PawaPay treasury mapping resolves the provider-clearing asset account used for the wallet source. Settlement relieves that clearing asset into the bank. This mapping does not by itself determine the accounting counterpart for staff payouts; expense, employee advance, inventory, and other category accounting remain separate decisions. PawaPay-reported wallet balance is a separate provider figure and must not be substituted for ITC treasury balance or holds.

## Service authentication

Expose this contract only on the private service network. Authenticate each request with an HMAC-SHA256 signature over the exact raw request bytes and canonical request metadata:

`key-id + "\n" + timestamp + "\n" + nonce + "\n" + method + "\n" + path-and-query + "\n" + request-id + "\n" + idempotency-key + "\n" + hex(SHA256(raw-body))`

Headers: `X-ITC-Key-Id`, `X-ITC-Timestamp` (Unix seconds), `X-ITC-Nonce` (UUID), `X-ITC-Signature` (base64url), `X-Request-Id`, and `Idempotency-Key` for mutations. Enforce a short timestamp window, constant-time signature comparison, a durable unique nonce claim, exact path/method binding, key rotation by key ID, bounded body size, and TLS. No browser cookie or caller-supplied actor identity is accepted as service authentication. The signed payload includes the initiating Expense Warrior actor and request ID for audit attribution. Secrets stay in environment/secret storage and are never logged.

For local configuration, generate a 32-byte random secret with `openssl rand -base64 32`. Set the same key ID and base64 value in Expense Warrior's `ITC_SERVICE_CLIENT_ID` and `ITC_SERVICE_CLIENT_SECRET`, and in ITC's `EXPENSE_WARRIOR_SERVICE_KEYS_JSON` map. Keep `EXPENSE_WARRIOR_FINANCE_ENABLED=false` until the target migration checksums, Treasury mapping, provider readiness, and reconciliation gates are verified.

## Version 1 endpoints

All amounts are decimal strings with exactly two fractional digits; currency is `ZMW`. Every mutation requires a UUID idempotency key and a stable caller-generated operation ID. Replaying the same key and fingerprint returns the original result; reusing it with different data returns `409 IDEMPOTENCY_CONFLICT`.

### Preflight a revenue or customer-credit collection before provider initiation

`POST /api/v1/internal/expense-warrior/collections/preflight` is a signed, fail-closed readiness check for `REVENUE` and `CUSTOMER_CREDIT` payment links. It accepts the persisted link target and provider identity so ITC can validate the same destination that Expense Warrior will later post. It intentionally does not accept `AR_SETTLEMENT`; A/R uses an exclusive receivable reservation as its pre-provider gate.

Example request body:

```json
{
  "payment_link_id": "<payment-link-uuid>",
  "collection_attempt_id": "<collection-attempt-uuid>",
  "actor_customer_id": "<active-itc-admin-uuid>",
  "provider_code": "pawapay",
  "provider_account_id": "<itc-provider-account-uuid>",
  "provider_account_version": 3,
  "target": {
    "type": "REVENUE",
    "revenue_account_code": "4000"
  }
}
```

For customer credit, `target` is exactly `{ "type": "CUSTOMER_CREDIT", "customer_id": "<active-standalone-customer-uuid>" }`. Unknown fields are rejected. The Expense Warrior client uses `X-Request-Id: <collection_attempt_id>` and `Idempotency-Key: ew-preflight-<collection_attempt_id>`; the signed request includes the exact raw body, path, timestamp, nonce, request ID and idempotency key under the standard HMAC-SHA256 service protocol. A ready response is `200 { "success": true, "data": { "ready": true } }`; callers must treat every non-affirmative or unavailable response as not ready.

ITC checks that the provider supports Zambia mobile money in ZMW; exactly one active provider-clearing Treasury mapping matches the payment method, currency, country and clearing asset class; the mapped Treasury and COA are active, postable and supported for that provider; the configured provider account is active for new payments, `READY`, and matches the provider, Treasury and version; and the actor is an active ITC admin. A revenue target must be an active, postable `REVENUE` account. A customer-credit target must be an active standalone customer and account 2020 must be active, postable `LIABILITY_CUSTOMER_CREDIT`.

The readiness queries run in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and always end with `ROLLBACK`, whether ready or rejected. They create no hold, reservation, journal, ledger entry or collection operation. Service authentication separately makes the required durable HMAC nonce-replay claim through `claim_expense_warrior_service_nonce`; that security write is outside the read-only readiness transaction and is not a finance/business posting. No schema migration is required for this endpoint, and no migration was applied for it.

This check is a point-in-time preflight, not a reservation or guarantee: provider-account, mapping, actor, or target readiness can change after the snapshot and before the provider call or final ITC posting. Expense Warrior must therefore persist the attempt first, call preflight before any deposit request, and call the existing authoritative ITC posting flow only after provider status and transaction details are verified. A denied or unavailable preflight is a known local failure: mark that attempt `FAILED` with `ITC_PREFLIGHT_REJECTED`, do not call the provider, and allow a new payment attempt with a new collection-attempt ID and idempotency key. A timeout/unknown result from the preflight is safe to treat as not submitted because this endpoint never initiates a provider transaction; it must not be confused with a timeout after provider submission. Do not apply this gate to A/R, whose active reservation is the concurrency control that must remain in place.

### Reserve (manager approval)

`POST /api/v1/internal/expense-warrior/holds`

```json
{
  "operation_id": "<uuid>",
  "request_id": "<expense-warrior-request-uuid>",
  "requester_customer_id": "<itc-customer-uuid>",
  "actor_customer_id": "<assigned-manager-customer-uuid>",
  "provider_code": "pawapay",
  "provider_account_id": "<itc-provider-account-uuid>",
  "provider_account_version": 3,
  "expense_category_code": "OFFICE_SUPPLIES",
  "amount": "125.00",
  "currency": "ZMW",
  "purpose": "Expense request <request-id>"
}
```

ITC resolves the provider-specific, active petty-cash ZMW treasury account server-side and verifies the provider account ID/code/version identity. It must not accept an arbitrary treasury account ID from Expense Warrior. In one ITC database transaction it locks the same treasury account row used by every treasury outflow, calculates posted balance less all active hold classes, rejects insufficient funds, records one hold with its immutable provider account identity, and writes audit evidence. Response includes the ITC `hold_id`, account reference, amount/currency, state, current posted balance, active held total, available amount, and `as_of` timestamp. This successful response is the only condition under which Expense Warrior may commit manager approval. A timeout is unknown: retry with the same operation/idempotency identity or query by `operation_id`; never create a replacement hold.

### Query an operation

`GET /api/v1/internal/expense-warrior/operations/:operation_id`

Returns the immutable operation identity, normalized state, hold reference if created, amount/currency, and timestamps. It does not mutate finance state. A not-found result is safe to retry only with the exact original operation ID and idempotency key after confirming the request body fingerprint.

### Read the authoritative balance

`GET /api/v1/internal/expense-warrior/balance` returns the configured petty-cash treasury's posted ZMW balance, active holds across Expense Warrior and existing mobile-money payouts, available balance, and an `as_of` timestamp. ITC locks the mapped treasury row for a shared read while summing holds so a concurrent reserve/outflow cannot produce an inconsistent snapshot. The signed service client is the only caller; the browser must use the Expense Warrior admin route. This is distinct from PawaPay-reported wallet balance.

### Read authoritative ledger history

`GET /api/v1/internal/expense-warrior/ledger-history?date_from=<ISO>&date_to=<ISO>&limit=<1..500>&cursor=<opaque>` returns only rows from the configured petty-cash treasury. The end timestamp is exclusive. Pagination uses a stable descending `(created_at, treasury_ledger_id)` cursor; every query applies the mapped treasury ID. Responses omit `notes`, `payment_reference`, and user identity fields. Expense Warrior handles user authorization, Lusaka date presets, export row caps, CSV/XLSX/PDF rendering, and export audit records.

### Read postable revenue accounts

`GET /api/v1/internal/expense-warrior/revenue-accounts` returns account codes and names for active, postable COA rows classified as `REVENUE`. Expense Warrior uses this signed catalog to require an explicit account mapping for general-revenue payment links. Returning an account does not mean every collection qualifies for it; the payment-link target and earned-revenue policy must be validated before posting.

### Release (rejection/cancel or definitive payout failure)

`POST /api/v1/internal/expense-warrior/holds/:hold_id/release`

Requires operation ID, actor, reason code, and reason. Release is idempotent and allowed only from `ACTIVE`; already released returns the original terminal evidence. A consumed hold cannot be released. Unknown provider payout outcomes do not release funds.

Expense Warrior admin rejection uses a durable local release operation identity and idempotency key. It records the rejection decision only after ITC confirms `RELEASED`; a timeout or local commit failure remains retryable with the same operation, actor, reason, and idempotency key.

### Consume after verified PawaPay payout success

`POST /api/v1/internal/expense-warrior/holds/:hold_id/consume`

Requires the stable operation ID, Expense Warrior request and payout-attempt IDs, provider code/account ID/account version, verified provider transaction/reference, active ITC expense-category code, exact amount/currency, verification timestamp, actor and evidence digest. ITC requires the consume provider identity to match the immutable identity stored at reservation. It validates the category maps to an active, postable OPEX account (inventory is rejected), requires an active hold with exact amount/currency, then atomically marks the hold consumed and posts one expense row, treasury debit, and balanced journal. The idempotency key is `ew-consume-` plus the lowercase SHA-256 hex digest of the provider transaction ID; reusing that provider transaction for another request conflicts. Provider initiation or callback alone is not proof; Expense Warrior calls this only after provider status verification matches the request, merchant reference, transaction, amount, currency, and terminal success. Exact replay returns the prior posting; mismatch conflicts and retains the hold for reconciliation.

### Post a confirmed payment-link collection

`POST /api/v1/internal/expense-warrior/collections/revenue` requires `revenue_account_code`; `/collections/customer-credits` requires `customer_id`; `/collections/ar-settlements` requires the approved full-balance receivable target and active reservation. Current ITC source has signed receivable listing/read/reserve/release and A/R settlement paths. The public preflight route intentionally supports only revenue/customer-credit targets; an A/R reservation is stronger and must succeed before provider submission. Every collection target requires stable operation, payment-link, and collection-attempt IDs; actor; provider code/account ID/account version; provider transaction/reference; exact amount/currency; verified timestamp; and a provider-evidence digest. Expense Warrior snapshots the provider identity on the attempt. ITC verifies that the account ID and provider code exist and map to the resolved provider Treasury; ITC stores this identity on the immutable collection operation. Existing collection operations without provider-account identity are not eligible for provider refund.

ITC validates the active actor, destination target, provider-specific Treasury mapping and clearing account, then writes the Treasury credit, balanced journal, global operation record, and (for customer credit) immutable credit entry in one transaction. Duplicate provider plus transaction, collection attempt, or idempotency identity cannot create a second posting. Exact replay returns the immutable original result; mismatched reuse conflicts. The public payment page cannot call ITC. Expense Warrior sends this only after authoritative provider status and amount/currency/destination checks. Customer-credit balance is available from `GET /customers/:customer_id/customer-credit` and is not A/R.

The PawaPay account mapping is a release prerequisite. `ITC_PAWAPAY_PROVIDER_ACCOUNT_ID` and `ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION` must point to the ITC account that uses the same PawaPay credentials as Expense Warrior; enabling PawaPay collection calls without both fails startup. These values are account metadata, not credentials. Other provider add-ons require their own ITC provider account and Treasury mapping. Legacy collection records are left unchanged. Expense Warrior's dedicated migrator now connects to its selected local database and reads migration status; migrations 0001–0012 match source checksums while 0013–0017 remain pending. No migration was applied.

**Current A/R release status:** ITC source on the existing `production` branch implements the receivable list/read/reserve/release and `/collections/ar-settlements` paths. The worktree also contains local credit-quote conversion, dispatch recognition, returns, credit notes, and collection-refund changes that have not been committed or deployed. Admin credit-quote conversion creates an unpaid `CREDIT` order with inventory reserved and no payment capture; A/R is recognized at dispatch. Fresh read-only ledger reads on local `local_staging` show 134/135/140/142 as `VERIFIED_ADOPTION`, 143 and 145–149 as `APPLIED`. No receivable/event/reservation counts or provider transaction are claimed. Do not infer readiness for another database or deployment.

## Cross-service failure handling

The services do not share a database transaction. Use an outbox/reconciliation state machine, not a distributed transaction:

1. Expense Warrior persists an approval operation as `RESERVATION_PENDING` with its stable operation ID.
2. ITC reserve is called with that ID. On confirmed success, Expense Warrior stores the ITC hold ID and advances to `MANAGER_APPROVED` in one local transaction.
3. If the local commit fails or the network response is unknown, keep the workflow pending and reconcile/query the same operation. Do not tell the user approval succeeded until both records agree.
4. Final admin approval creates exactly one payout command under a stable provider idempotency identity. A verified terminal provider failure releases the hold; a verified terminal success consumes it; timeout/unknown retains it.
5. Reconciliation is alertable and append-only. It must not invent a second hold, payout, release, credit, or debit.

## ITC treasury invariants required before implementation

- Existing treasury outflows and all Expense Warrior holds serialize on the same account lock, so concurrent holds, transfers, fees, and payout commands cannot overspend.
- Available balance is calculated by ITC from its posted ledger minus all active holds, not from a provider balance snapshot.
- Hold rows and operation identities are durable and unique by source request/operation; terminal transitions are one-way and audited.
- Consume writes the hold resolution, treasury ledger entry, balanced journal, and source identity atomically.
- Collection credits and payout debits have globally unique source event keys and safe exact replay behavior.
- The configured petty-cash treasury account and its valid ZMW/provider funding semantics must be verified before enabling calls. Existing supplier/vendor/payroll payout APIs are not directly reused because their payable/accounting ownership is different.

## Readiness gate

The A/R migration chain is recorded on local `local_staging`; do not replay it there. Before enabling finance operations in any environment, verify that environment's exact migration ledger, account/provider mapping, service-key provenance, PawaPay account-level signed-only enforcement, and nonce/collection schema; run the disposable-PostgreSQL transaction/concurrency suite and authenticated end-to-end reconciliation. Keep collection and payout flags off until those checks pass. Expense Warrior's local dedicated migration role works, but migrations 0013–0017 remain pending. Local config has finance and credit-invoice/refund gates off, with required ITC service credentials, PawaPay account identity/version, service-key map, and Treasury mapping absent. No provider call, migration, refund, or financial posting was performed in this validation. Delivered-invoice A/R remains approved for V1; local schema readiness does not prove live ITC or provider behavior.

## Historical preflight implementation evidence (2026-10-18)

- Expense Warrior API: branch `codex/itc-migration-ledger-clarification`, current evidence commits `0bad687` and `f70c930`; the unrelated untracked `tsconfig.json` is user-owned and preserved.
- ITC backend at that time: local integration branch `codex/expense-warrior-v1-unified`. This branch reference is historical; the current source is on `production` as noted above.
- Frontend retry state: branch `main`, final `7ce28e173d881cbee055df5dfedc25f18e8464fa`.
- Validation: ITC finance service/route/protocol tests 38/38; Expense Warrior client/payment-service tests 39/39; full Expense Warrior API suite 383 passed and 4 PostgreSQL-gated skips; frontend 59/59 and production build passed. Independent cross-repo reviews found no concrete issues.
- A mobile viewport browser check at port 5175 used mocked public API responses. It confirmed the failed-payment message, reachable retry CTA, form restoration and fresh idempotency keys on two submissions. No PawaPay request was made.
- Latest read-only checks used `scripts/codex_db.js` with the dedicated `shopit_accounting_audit` role in a `READ ONLY` transaction. `local_staging` resolves the five expected 134–135 tables, has no migration ledger rows 134–140, and reports account 1100 inactive/non-postable. In `itc`, the role connects but is denied schema `public` access, so object and ledger status remain unverified. These checks do not prove application-runtime grants or live transaction/concurrency behavior.
- No migration was applied or adopted, no database write was made, and no payment/provider call was initiated. Before production collection, verify ITC target grants/configuration and the PawaPay account-level signed-requests-only setting, keep finance flags disabled until all release gates pass, and complete authorized reconciliation validation.
