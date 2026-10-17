# Expense Warrior ↔ ITC Finance Service Contract

**Status:** The owner manually ran ITC migration SQL 134–135. Read-only catalog checks confirm their expected schema tables exist in both requested databases (`itc` and `local_staging`). Running SQL manually does not update `commerce_schema_migrations`; the ledger rows/checksums are not verified, which is not evidence that the schema migrations are absent. ITC now provides a guarded verified-adoption command that checks schema readiness and records the matching source checksums without reapplying DDL; it has not been run. Signed internal routes cover balance, reserve, release, consume, revenue collection, customer-credit collection, delivered receivable lookup, reservation, and A/R settlement. Finance calls remain disabled by default. Revenue/customer-credit collection writes Treasury, a balanced journal, and immutable operation/subledger records in one transaction. Account 2020 is the dedicated customer-credit liability; account 2000 remains paid-order advances. A/R source code is implemented with migrations 136–137, but those migrations are unapplied and the flow remains disabled operationally until release/database verification. Signed, read-only PawaPay sandbox active-configuration and wallet-balance GETs were performed from Expense Warrior; no deposit, payout, refund, ITC financial post, or migration apply was performed.

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
- ITC exposes signed `POST /api/v1/internal/expense-warrior/collections/revenue` and `/collections/customer-credits`, plus `GET /customers/:customer_id/customer-credit`. The A/R endpoints list only delivered, eligible invoices, reserve a single full-balance payment before provider initiation, and atomically post against the receivable after verified success. V1 excludes undelivered quotes and storefront orders from A/R. Keep A/R disabled until migrations 136–137 and account readiness are verified in the target environment.
- ITC exposes signed, read-only balance and keyset-paginated ledger-history endpoints for the mapped treasury. Balance serializes with reserve/outflow locks, sums active mobile-money payout and Expense Warrior holds, and returns posted, held, and available ZMW values. History is ordered newest-first by `(created_at, treasury_ledger_id)`, bounded to 500 rows per page, filters a half-open timestamp range, and omits free-text notes and payment references. Expense Warrior proxies admin access and generates bounded audited CSV/XLSX/PDF exports. These paths remain behind the disabled-by-default finance service flag and depend on migration 134's nonce/finance objects; the objects are present in both requested databases, while ledger/checksum confirmation remains incomplete.
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

`POST /api/v1/internal/expense-warrior/collections/revenue` requires `revenue_account_code`; `/collections/customer-credits` requires `customer_id`; `/collections/ar-settlements` requires the full receivable and reservation identity. Every target requires stable operation, payment-link, and collection-attempt IDs; actor; provider code/account ID/account version; provider transaction/reference; exact amount/currency; verified timestamp; and a provider-evidence digest. Expense Warrior snapshots the provider identity on the attempt. ITC verifies that the account ID and provider code exist and map to the resolved provider Treasury; A/R also requires the exact account version used by its active reservation. ITC stores this identity on the immutable collection operation. Existing collection operations without provider-account identity are not eligible for provider refund.

ITC validates the active actor, destination target, provider-specific Treasury mapping and clearing account, then writes the Treasury credit, balanced journal, global operation record, and (for customer credit) immutable credit entry in one transaction. Duplicate provider plus transaction, collection attempt, or idempotency identity cannot create a second posting. Exact replay returns the immutable original result; mismatched reuse conflicts. The public payment page cannot call ITC. Expense Warrior sends this only after authoritative provider status and amount/currency/destination checks. Customer-credit balance is available from `GET /customers/:customer_id/customer-credit` and is not A/R.

The PawaPay account mapping is a release prerequisite. `ITC_PAWAPAY_PROVIDER_ACCOUNT_ID` and `ITC_PAWAPAY_PROVIDER_ACCOUNT_VERSION` must point to the ITC account that uses the same PawaPay credentials as Expense Warrior; enabling PawaPay collection calls without both fails startup. These values are account metadata, not credentials. Other provider add-ons require their own ITC provider account and Treasury mapping. Legacy collection records are left unchanged. Migration 139 and the Expense Warrior attempt-snapshot/provider-add-on lifecycle migrations are source-only; none has been applied as part of this design work.

`GET /api/v1/internal/expense-warrior/customers/:customer_id/receivables` returns a bounded, keyset-paginated list of delivered, positive-outstanding ZMW receivables that do not have an active reservation. `GET /api/v1/internal/expense-warrior/customers/:customer_id/receivables/:receivable_id` revalidates a specific customer/invoice target before link creation. Expense Warrior must treat these as current ITC facts and must not maintain its own authoritative receivable balance.

`POST /api/v1/internal/expense-warrior/receivable-reservations` reserves the exact full outstanding amount before provider initiation; a unique active reservation prevents concurrent links from charging the same invoice. `POST /api/v1/internal/expense-warrior/receivable-reservations/:reservation_id/release` accepts only a definitive provider failure and appends an immutable release event. Unknown provider outcomes retain the reservation for reconciliation. For verified success, `POST /api/v1/internal/expense-warrior/collections/ar-settlements` validates the active reservation and atomically debits the mapped PawaPay clearing account (1020), credits Trade Receivables (1100), reduces the receivable, appends its collection event, and marks the reservation applied. Exact retries are idempotent. ITC migrations 136/137 must be applied and verified before enabling these endpoints; source presence alone is not readiness.

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

Before applying migrations or enabling finance operations, review the exact target and migration checksum, verify account/provider mappings and signed-key provenance, confirm nonce and collection tables are ready, and run the disposable-PostgreSQL transaction/concurrency suite. Keep collection and payout feature flags off until the guarded migrations are explicitly authorized and applied, an authorized end-to-end verification passes, and reconciliation/monitoring is ready. Do not create a payment during source validation. Delivered-invoice A/R remains disabled until migrations 136/137 are applied and verified in the target, account 1100 identity/readiness is confirmed, and authorized transaction/concurrency and provider reconciliation checks pass. Credit-note/return handling remains incomplete before credit invoices are used for live sales.
