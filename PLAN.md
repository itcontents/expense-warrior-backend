# Expense Warrior Backend Plan

## Responsibilities and boundaries

## A/R integration status (2026-10-16)

Migrations 136–139, guarded release registration, and signed ITC A/R and collection-refund operations are implemented source-only in the isolated `itcstore-backend` integration worktree. ITC source supports admin-only credit quote conversion, dispatch-time recognition to Trade Receivables account 1100, delivered receivable listing, full-balance exclusive reservations, definitive-failure release, atomic collection posting, and first-class refund identity for verified Expense Warrior collections. Expense Warrior validates receivables on link creation, reserves before PawaPay initiation, releases only on definitive provider failure, posts verified success through ITC, and routes eligible settled-collection returns through the existing refund worker and accounting workflow. Credit-note schema, source-journal reconciliation, posting service, and the separate `CREDITED` approval path have focused policy, schema, mocked-posting, source-journal, notification, guard, and model-transaction tests. The model tests cover rollback on an active reservation, atomic mocked commit of the credit note/receivable/decision/outbox event, and write-free replay validation. On 2026-10-15, 70 focused Expense Warrior finance, receivable, credit-note, and refund source tests passed, including migration guards and replay checks; these are unit/contract tests, not live PostgreSQL transaction or concurrency evidence. Live PostgreSQL transaction, concurrency, and replay coverage is still required. The migrations have not been applied, so these A/R, credit-note, and collection-refund flows are not ready to enable against ITC; no credit dispatch, payment, refund, or financial posting was run against a database. See the ITC credit-sale, credit-return, and collection-refund plans in that worktree for details.

## PawaPay refund capability status (2026-10-15)

The Expense Warrior PawaPay adapter exposes signed refund initiation against the original deposit ID and signed refund-status lookup. These operations are connected to approved ITC return requests, persistent refund identity, retry/reconciliation behavior, and ITC source-specific treasury accounting. The owner approved the first-class Expense Warrior collection refund source on 2026-10-16. The API shape follows [PawaPay's V2 refund initiation](https://docs.pawapay.io/v2/api-reference/refunds/initiate-refund) and [refund status](https://docs.pawapay.io/v2/api-reference/refunds/check-refund-status) docs. Provider-level mocked contract tests pass. Migration 139 remains unapplied and live sandbox refund verification has not been performed. No refund call was made.

## Implementation status (2026-10-16)

- Local database: a fresh read-only audit on 2026-10-16 confirms the connection is `expense_warrior` as restricted, non-superuser role `expense_warrior_app`; Expense Warrior migrations `0001`–`0012` match source checksums. Migration `0013_payment_link_provider_account_snapshot.sql` remains unapplied, so PawaPay collection attempts stay gated. Runtime PawaPay collection/payout flags are false and signed-requests-only account confirmation is true. API readiness and the preview both returned HTTP 200. The owner reports ITC migrations `134` and `135` were applied to `itc` and `local_staging`; expected schema objects were observed, but exact ITC migration ledger/checksum confirmation remains incomplete. See [migration verification note](docs/itc-migration-134-135-verification-2026-10-15.md). No ITC migration was applied by this work.
- A gated `npm run test:postgres` passed against the local `expense_warrior` schema using `expense_warrior_app`. It derives session-local temporary tables from existing tables and exercises real request submission, manager assignment snapshot, attachment metadata, idempotent replay/conflict, manager-queue scoping, and transaction rollback. It does not mutate persistent rows, apply migrations, or test multi-connection concurrency; that coverage remains required.
- The same gated PostgreSQL command now also exercises payment-link creation replay/conflict, multiple attempts on a reusable link, source-only migration 0013 provider-account snapshots on a session-local table, verified-success persistence, and closure/audit of every active A/R link for a settled receivable. Both PostgreSQL tests pass with the restricted runtime role; no persistent application rows or migrations are changed. Multi-connection concurrency and live ITC finance verification remain outstanding.
- A third PostgreSQL check now executes the real request submission, manager reservation-pending/hold-confirmed transitions, admin payout preparation, and exact replay through temporary tables. This proves the local transaction and constraint behavior across both approval stages without contacting ITC or PawaPay; provider submission, ITC holds, and concurrent races remain unverified here.

- Complete locally: standalone Express/PostgreSQL service foundation, ITC session validation, approved category seed, request submit/list and scoped approval queues, request idempotency, Cloudinary authenticated request-image storage with scoped API proxy reads, and admin-only manager assignment APIs with effective dating and audit events.
- Complete locally: stage-scoped manager/admin rejection decisions, reason validation, transactional audit events, and safe replay of an identical rejection.
- Complete locally in ITC source: consuming a verified staff payout atomically marks its active hold consumed, records an expense using a caller-supplied ITC expense category that must map to active postable OPEX, debits the PawaPay treasury, and writes a balanced journal. Provider transaction IDs derive the global consume idempotency key so a transaction cannot post to two requests. Migration 134 objects are present in both requested databases; migration tracking evidence remains incomplete as described in the verification note.
- Complete locally: admin-only eligible-staff directory lookup through ITC; the endpoint returns minimal fields, excludes vendor-scoped staff, and supports bounded search and pagination.
- Complete locally: a lazy PawaPay provider registry and signed v2 client for deposits, payouts, transaction status, active configuration, phone prediction, and wallet balances. The client restricts hosts to the official sandbox/production URLs, requires a P-256 signing key for calls, checks private-key file permissions, bounds responses and timeouts, and marks ambiguous financial POST outcomes unknown without automatic retries. Contract tests use generated keys and mocked HTTP only.
- Complete locally: manager approval persists a stable ITC reservation operation before calling finance, verifies the returned active hold, and keeps ambiguous outcomes pending for exact retry. Admin rejection of a manager-approved request persists a stable release operation, calls signed ITC release, and records rejection only after confirmed release; ambiguous outcomes remain retryable in the admin queue.
- Complete locally: an admin-only provider-balance read route fetches Zambia wallet balances through the signed PawaPay client, caches for 30 seconds, supports an explicit refresh, coalesces concurrent reads, and marks stale cached results if the provider is unavailable. It reports provider balances separately and does not expose a ledger-available balance.
- Complete locally: an admin-only wallet ledger panel fetches posted balance, active holds, and available ZMW from ITC's signed read-only finance endpoint, clearly separate from the PawaPay provider balance.
- Complete locally: admin-only fixed-amount payment-link management endpoints. Link creation is actor-scoped and idempotent, stores only a SHA-256 token hash plus request fingerprint, returns the opaque token for the authenticated create/replay request, supports reuse indefinitely, and records one create/disable audit event per state change.
- Complete locally: public checkout routes and collection-attempt persistence for reusable links. The service initiates signed PawaPay deposits once per idempotency key, polls provider status, verifies transaction identity, Zambia/currency/amount/network/phone, and leaves verified provider success at `VERIFIED_PENDING_LEDGER`; checkout does not claim paid or issue a receipt before ITC posting.
- Complete locally: a public receipt PDF endpoint scoped by the opaque link token and attempt ID. It serves only verified attempts already marked `SUCCEEDED` with an ITC ledger operation, masks the payer number, and sends a private no-store attachment; pending, failed, unposted, malformed, and cross-link attempts receive no receipt.
- Complete locally: the provider registry advertises operation-specific network capabilities from lazily registered adapters, and the public payment page uses the deposit list. The registry verifies each adapter's operation methods and rejects malformed or missing capabilities. Adapter definitions can be registered without rewriting checkout flow. If more than one adapter claims the same network, checkout hides that ambiguous route and refuses attempts until an explicit route is selected; the current V1 registry has only PawaPay.
- Complete locally: admin-only request reports with Today, Yesterday, This month, Last month, and custom Africa/Lusaka date windows; deterministic newest-first query, optional status/category filters, CSV/XLSX/PDF download, spreadsheet-formula protection, bounded output, and one audit record per successful export.
- Complete locally: signed ITC ledger-history reads with stable keyset pagination, admin-only Expense Warrior proxy, mobile activity display, and authorized CSV/XLSX/PDF wallet-history exports for the same Africa/Lusaka presets/custom range. Exports enforce row caps and write an audit event; reads omit ledger notes and payment references.
- Complete locally: admin-managed staff payout destinations verified against ITC's active staff directory, encrypted using an identity-bound AES-256-GCM keyring, versioned with append-only history, masked in responses, and snapshotted immutably on each staff request. The Team screen can assign destinations; staff can see only their own masked destination.
- Complete locally: admins can explicitly reveal the immutable destination on an eligible request through a no-store endpoint. Access is recorded in the Expense Warrior audit log with network and last four digits only; request-list responses remain masked/phone-free.
- Complete locally: admins can map eligible Expense Warrior categories to the signed ITC postable OPEX catalog. Manager approval resolves the leaf category first, falls back to the parent, and snapshots both ITC category and account codes when it reserves the funds. Stock categories cannot map to OPEX. The additive mapping migration is applied only to the local Expense Warrior database.
- Complete locally in source: final admin approval, ITC reservation for no-manager requests, signed PawaPay payout initiation/status recovery, exact provider and ITC evidence matching, ITC hold consumption, confirmed-failure release, and admin-only bulk approval. Unresolved outcomes remain held and visible in an admin recovery queue. These paths are covered by mocked service tests only; ITC migration 134 objects are present but its ledger/checksum is unverified, payout calls are disabled by default, and no provider or ITC finance call has been made. The cross-service recovery protocol is documented in [ITC Finance Service Contract](docs/itc-finance-service-contract.md).
- Complete locally: a default-off PawaPay callback intake route verifies the exact raw signed request before parsing, bounds JSON to 64 KiB, and appends only transaction IDs, provider status hints, signature metadata, and a payload hash. It accepts one deposit or payout callback record, returns an idempotent duplicate acknowledgement, and never changes attempts, approvals, holds, or ledger state.
- Complete locally in source: signed ITC customer search for the admin customer-link workflow. It is bounded and read-only, searches active non-vendor customer accounts, returns a display label and only the last four phone digits, and is exposed through an admin-only Expense Warrior proxy.
- Complete locally in source: signed ITC revenue-account/customer catalogs; payment-link target persistence and admin UI selection; and ITC collection routes for revenue and customer credit. ITC posts PawaPay-mapped Treasury credits, balanced journals, an immutable collection operation, and customer-credit events atomically. Customer credit uses dedicated, active/postable liability account `2020 Customer Credit Payable`, separate from `2000 Customer Advances`.
- Complete locally in source: delivered-invoice A/R links are full-balance only. ITC validates the delivered receivable at link creation, serializes one active reservation per invoice before provider initiation, releases only on a definitive provider failure, and atomically posts a verified collection against account 1100. Expense Warrior disables all active links for that invoice after confirmed posting. Quote-converted prepaid invoices and storefront orders remain unchanged. Customer-credit links do not settle invoices.
- Revenue/customer-credit posting and payouts remain gated by default. Revenue collection has no VAT calculation or classification; leave it disabled unless the selected account and tax policy are approved. ITC migrations 136–137 are not applied, and the exact 134–135 migration ledger/checksum evidence remains incomplete. Expense Warrior migrations 0001–0012 are applied only to its dedicated local database. Provider balance snapshots remain separate from ITC wallet ledger history. No provider call or financial post was initiated during this work.

Expense Warrior is an independently deployed API and PostgreSQL service. Its database owns request/link workflows, category hierarchy, manager assignments, attachment metadata, provider attempts, workflow reservations, and audit history. ITC remains authoritative for user identity and accounting/treasury ledger operations. Expense Warrior uses authenticated APIs only and never connects to the ITC database. Every public payment link collects funds into the company petty-cash wallet; links do not settle employee requests. Keep route/controller, validation, application service, persistence, and provider adapter responsibilities separate. The frontend never supplies an authoritative balance, approval permission, provider routing choice, or payment-success flag.

Use a small standalone service rather than a distributed microservice mesh: one Expense Warrior API process and one dedicated PostgreSQL database, with narrow ITC integration APIs. This isolates request/link schema and releases while preserving ITC's shared identity and ledger authority. The ITC repo's current `expenses` records are already-posted expenses and its categories require accounting mappings (`inventory` is reserved); do not model employee requests by inserting into those tables. V1 uses PawaPay for payment-link collections and approved staff payouts on Airtel, MTN, and Zamtel. Keep separate deposit, payout, balance, and status operations in a small versioned adapter contract and explicit registry; do not copy Shop.IT order coupling or assume every future adapter supports every network.

```text
Vue frontend (front/)
  └── Expense Warrior API (back/)
       ├── Expense Warrior PostgreSQL (requests, approvals, links, attempts)
       ├── Cloudinary authenticated evidence assets
       ├── provider registry → PawaPay adapter (V1; balance, deposits, payouts)
       └── ITC signed service client
              ├── ITC identity/session validation
              └── ITC treasury holds and authoritative ledger
```

The existing `itcstore-backend` PawaPay client and payout workflow provide useful signing, status-verification, callback, and idempotency patterns. Reuse focused behavior after review, but do not copy `MobileMoneyPayoutModel` wholesale: it is coupled to supplier/vendor/payroll accounts and chart-of-account rules. Expense Warrior owns PawaPay configuration and provider balance reads. The PawaPay balance endpoint is `GET /v2/wallet-balances` (optionally filtered by country); the inspected ITC client has no balance method, so implement and test it in Expense Warrior's provider adapter. Cache only for a bounded period, expose retrieval time/staleness, and refresh explicitly rather than on every render. Keep provider-reported balance, ITC ledger balance, and ITC holds visibly separate.

### PawaPay financial request signing

Cryptographically sign every PawaPay financial request. Treat signing as mandatory (`PAWAPAY_SIGNATURE_ENABLED=true`), keep private keys server-side with restrictive permissions, and fail closed if signing is unavailable. PawaPay public-key discovery is the sole unsigned request in the existing client. Enable PawaPay's **signed requests only** account setting in its dashboard as well; local headers alone do not make PawaPay reject unsigned calls. Verify signed callbacks separately before applying any financial state transition. Financial service calls from Expense Warrior to ITC also need a separate authenticated service contract with replay prevention, actor context, scoped operations, and idempotency.

The Expense Warrior adapter lives at `src/providers/pawapay/PawaPayClient.js`; `src/providers/providerRegistry.js` is the provider selection seam. `src/providers/providerAddons.js` loads explicitly registered add-on adapters at server startup; each adapter advertises operation-specific networks and supplies the methods it supports. V1 uses the PawaPay v2 HTTPS host, SHA-512 `Content-Digest`, and ECDSA P-256 HTTP message signatures. The API client signs its requests, never retries a financial POST, and reports network/timeout/5xx outcomes as unknown. It is mounted on collection, payout, balance, and callback paths, each behind its operation feature gate. Account-level signed-request enforcement and signed-callback verification remain launch gates.

PawaPay's public market information lists Zambia Airtel, MTN, and Zamtel, and its live status page lists deposit and payout service for these operators. Public availability does not prove this merchant account is enabled. Confirm credentials, network configuration, payout funding rules, amount limits, signed-request account enforcement, and sandbox behavior in the Expense Warrior account before enabling financial calls. Show PawaPay-reported balances separately from the app's ledger and held amount. Collection settlement to the company's bank and funds available for PawaPay payouts are different concepts; do not present one as the other.

Provider responsibilities should normalize deposit/payout initiation, server-side status verification, and authenticated webhook notifications into internal attempt states. A callback is a hint that triggers verification, not proof of payment. Request an ITC ledger credit only after authoritative provider evidence matches the payment-link attempt, merchant reference, destination/account, amount, and currency. Unknown outcomes remain recoverable and must not start another provider operation automatically.

## Proposed core data model

Use UUID primary keys, UTC `timestamptz` event timestamps, ZMW `numeric(14,2)` amounts, database constraints for valid states, and append-only financial history. Persist dates in UTC; compute report windows using the Africa/Lusaka timezone. Store provider/network codes separately from public display labels.

- Store ITC `customer_id` values as external identity references; do not duplicate passwords, roles, or user records. Resolve active status and base role through a reviewed ITC identity/session API. Add `employee_manager_assignments` in Expense Warrior with effective dates, assignment actor, and audit fields. A manager is an assigned ITC staff user with Expense Warrior manager capability; do not misuse ITC's vendor-to-staff `parent_vendor_id` relationship or add a global manager role for V1.
- `expense_categories`: parent category, optional parent ID, stable code, label, active state, and configurable reason/attachment policy. Deactivate categories referenced by history instead of deleting them. The approved V1 starter taxonomy is below.
- `staff_payout_destinations`: staff user, mobile network, normalized phone, verification state, active/default markers, and audit data. Admin manages destinations in V1; snapshot the selected destination onto a request so later edits do not change an in-flight approval.
- `expense_requests`: requester, category, amount, reason, state, submitted timestamp, and immutable created/updated metadata.
- `expense_request_attachments`: request, opaque Cloudinary object key, media type, size, checksum, uploader, timestamp. Upload evidence with Cloudinary's `authenticated` delivery type, and proxy reads through the authenticated API after request-scope authorization. Never store or return Cloudinary delivery URLs.
- `request_decisions`: request, approve/reject action, actor, reason, timestamp, and idempotency/conflict control. Preserve the decision trail.
- `provider_balance_snapshots`: provider/account, currency, amount, provider-reported timestamp, retrieval timestamp, and safe response metadata. The provider API is the source for the displayed PawaPay balance; local snapshots support availability/outage display and reconciliation, not balance authority.
- **Finance integration:** ITC owns treasury balances, holds that constrain available funds, and ledger postings. Expense Warrior stores external operation IDs and a mirror of hold status for workflow/reconciliation only. ITC must provide atomic, idempotent reserve/release and collection-credit/payout-debit APIs; a balance read followed by a separate local hold is race-prone. See [ITC Finance Service Contract](docs/itc-finance-service-contract.md) for the proposed signed API, payloads, and cross-service recovery protocol. Do not create a second posted wallet balance or duplicate the generic expense ledger.
- `request_payouts`: admin-approved request, destination phone, mobile network, provider payout ID/reference, amount, idempotency key, normalized state, provider evidence identity, and timestamps. Require review of the destination before final admin approval; never store or request a mobile-money PIN.
- `payment_links`: opaque public token hash, fixed amount, description, allowed/available network configuration, creator, active/disabled state, and optional payer metadata. Links do not expire and can receive multiple completed payments; an admin can disable a link. Store only token hashes where feasible; never expose internal IDs or enumerable identifiers publicly.
- `collection_attempts`: link, internal merchant reference, provider/account, network, normalized phone, amount/currency, attempt state, provider transaction/reference IDs, timestamps, and idempotency keys. Each payer submission is its own attempt; allow multiple successful collections against a reusable link and issue one receipt per successful collection.
- `request_fund_holds`: request, ITC hold reference, amount/currency, mirrored reserve/release/consume state, manager/admin actor, idempotency key, and last reconciliation timestamp. ITC performs the authoritative available-funds check and hold under a database lock; preserve the hold through final payout verification.
- `provider_events`: durable, deduplicated webhook/event receipt with minimal necessary payload evidence and processing state; redact credentials and sensitive personal data.
- `audit_events`: actor, action, target, timestamp, request correlation ID, and safe before/after metadata for role changes, category changes, approvals, transfers, links, exports, and corrections.

The admin view reads the provider-reported balance from PawaPay and shows its retrieval time. ITC holds and ITC ledger balances are shown separately; do not mutate a provider balance locally or label it as a bank balance. A successful PawaPay payout consumes the ITC hold and posts the debit exactly once through ITC's service boundary. Link collections, payouts, and settlements must reconcile to provider references/statements. Corrections create a compensating ITC entry and audit event; never edit/delete a posted transaction.

## State transitions

### Expense request and two-stage approval

`SUBMITTED → MANAGER_APPROVAL_PENDING_HOLD → MANAGER_APPROVED → ADMIN_APPROVED/PAYOUT_PENDING → PAID`, with rejection at either review stage. If no manager is assigned, route directly to admin review. The assigned manager can see and review only their staff's requests. The destination phone/network is captured from the staff user's admin-managed payout destination and snapshotted onto the request. Manager approval becomes effective only after ITC confirms an idempotent funds hold; an unknown result remains recoverable under the same operation reference. Final admin approval starts the payout once enabled in the provider phase. Only admins can bulk-approve manager-approved requests; show the total and per-request eligibility before confirmation. Every decision is a separately audited transition, rejection requires a reason, and self-approval is prohibited for every role. A stale/ineligible item must be reported individually, never silently marked approved.

### PawaPay staff payout

`ITC_HELD → SUBMITTING → PENDING/VERIFICATION_REQUIRED → SUCCEEDED | FAILED`. Final admin approval submits one idempotent PawaPay payout to the staff member's verified mobile network and phone. A successful, identity/amount/currency-matched result consumes the ITC hold and posts the debit once. Definitive failure releases the hold through ITC. Unknown submission/status retains the hold and blocks a replacement payout until reconciled. Keep provider callbacks as hints and verify server-side before posting.

### Payment link collection

`ACTIVE → DISABLED` with no time-based expiry; each payment link supports multiple independent collection attempts/payments. Attempts follow normalized states such as `CREATED → SUBMITTING → PENDING/ACTION_REQUIRED → SUCCEEDED | FAILED | VERIFICATION_REQUIRED`. Provider success is applied once per attempt, under a database transaction, as a collection credit. `VERIFICATION_REQUIRED` remains pending/recoverable, is visible to admins, and cannot be submitted twice as the same attempt. Receipt availability follows applied success only. Public routes still check link active/disabled state and apply rate limits even though links do not expire.

## Approved V1 category starter set

Use a short, configurable taxonomy with a category and optional subcategory. Keep category codes stable even when display names change. Seed the approved first-release set below:

| Category | Suggested subcategories |
|---|---|
| Stock and Purchasing | Resale inventory, supplier top-up, packaging for resale |
| Transport and Travel | Local transport, fuel, parking/tolls, delivery/dispatch |
| Overtime and Casual Labour | Staff overtime, temporary/casual labour |
| Shipping and Courier | Courier, freight, parcel delivery |
| Office Supplies | Stationery, cleaning supplies, small office consumables |
| Phone and Internet | Mobile data, airtime/talktime, internet bundle |
| Utilities | Electricity, water, other approved utility |
| Repairs and Maintenance | Office, equipment, vehicle |
| Meals and Meetings | Staff meal, meeting refreshments |
| Bank and Service Charges | Bank fee, mobile-money fee, other service charge |
| Other | Admin-configured subcategories; require a clear reason and admin review |

For every category, allow policy flags such as `reason_required`, `attachment_required`, and an optional receipt threshold. Keep accounting mapping separate from the display category. For staff payouts, an admin must explicitly map each eligible Expense Warrior category to an existing ITC expense category backed by an active postable OPEX account; never infer account mappings from labels. Do not map resale stock categories to OPEX: merchandise purchases require ITC's stock-receiving workflow. Payment-link revenue account and tax classification still need confirmation before any collection posting.

## Provider research references

- [PawaPay Merchant API](https://docs.pawapay.io/v2/docs/welcome) — use the current deposit, status lookup, callback/security, and sandbox sections when adapting the local client.
- [PawaPay platform status](https://status.pawapay.io/) — live operational status, which can change and is not a merchant entitlement check.
- [PawaPay plans and FAQs](https://www.pawapay.io/plans) — supported markets, onboarding, fees, limits, and settlement information; verify the applicable Zambia/operator terms with the merchant account.
- Existing implementation to review: `itcstore-backend/src/integrations/pawapay/PawaPayClient.js`, `itcstore-backend/src/integrations/payments/PawaPayProvider.js`, `itcstore-backend/src/integrations/payments/providerContract.js`, `itcstore-backend/src/integrations/payments/providerDefinitions.js`, and the focused PawaPay/provider adapter tests. These paths are research references, not runtime dependencies.

## PawaPay sandbox setup and test cases

PawaPay's official guide says each new account starts with an isolated sandbox and sandbox API token; use base URL `https://api.sandbox.pawapay.io` and obtain credentials from the sandbox dashboard. Sandbox uses provider-specific test MSISDNs and simulated outcomes without real wallets or money. **The PIN/authorization prompt is not shown in sandbox**, so validate the actual prompt UX only in an explicitly authorized live test after merchant onboarding; do not treat sandbox status tests as proof of that UX.

Use only the published sandbox numbers for sandbox tests:

| Network | Test number | Simulated deposit result |
|---|---|---|
| Airtel Zambia | `260973456019` | `PAYER_LIMIT_REACHED` |
| Airtel Zambia | `260973456039` | `PAYMENT_NOT_APPROVED` |
| Airtel Zambia | `260973456049` | `INSUFFICIENT_BALANCE` |
| Airtel Zambia | `260973456069` | `UNSPECIFIED_FAILURE` |
| Airtel Zambia | `260973456129` | `SUBMITTED` |
| Airtel Zambia | `260973456789` | `COMPLETED` |
| MTN Zambia | `260763456019` | `PAYER_LIMIT_REACHED` |
| MTN Zambia | `260763456029` | `PAYER_NOT_FOUND` |
| MTN Zambia | `260763456039` | `PAYMENT_NOT_APPROVED` |
| MTN Zambia | `260763456069` | `UNSPECIFIED_FAILURE` |
| MTN Zambia | `260763456129` | `SUBMITTED` |
| MTN Zambia | `260763456789` | `COMPLETED` |
| Zamtel Zambia | `260953456704` | `INSUFFICIENT_BALANCE` |
| Zamtel Zambia | `260953456712` | `UNSPECIFIED_FAILURE` |
| Zamtel Zambia | `260953456789` | `SUBMITTED` |
| Zamtel Zambia | `260953456700` | `COMPLETED` |

These are provider test fixtures, not real subscriber numbers. Keep them in sandbox-only test fixtures. Exercise successful and failed deposits and payouts, pending/recovery, duplicate callbacks, and idempotent retries. The admin balance integration uses the documented `GET /v2/wallet-balances?country=ZMB` endpoint with the sandbox token; verify account permission and returned wallet semantics before using its amount for payout eligibility.

References: [sandbox setup](https://docs.pawapay.io/v2/docs/how_to_start), [sandbox test numbers](https://docs.pawapay.io/v2/docs/test_numbers), [wallet balances API](https://docs.pawapay.io/v2/api-reference/finances/wallet-balances), [deposit flow](https://docs.pawapay.io/v2/docs/deposits).

## Role and access policy

Enforce permissions server-side on every endpoint and object. Proposed baseline:

| Capability | Staff | Manager | Admin | Public payer |
|---|---:|---:|---:|---:|
| Create request and view own requests | Yes | Yes | Yes | No |
| View scoped team queue and decide requests | No | Yes | Yes | No |
| Bulk final-approve eligible manager-approved requests | No | No | Yes | No |
| View company wallet and all transactions | No | Scoped/optional | Yes | No |
| Initiate final staff payout | No | No | Yes, after final approval | No |
| Create/manage payment links and reports | No | No by default | Yes | No |
| Pay a public link and download its receipt | No | No | No | Token-scoped only |

Keep role permissions configurable only if needed; start with a small explicit permission matrix. Self-approval is prohibited for every role with no exception. Manager scope is based on the assigned staff relationship and must be represented in data and queries, not inferred from UI filtering. If an admin submits a request, a different admin must approve it; decide whether to require a second admin account before enabling admin requests.

## API surface (initial proposal)

- `GET /api/v1/me`, `GET /api/v1/categories`
- `POST /api/v1/requests`, `GET /api/v1/requests`, `GET /api/v1/requests/:id`
- `POST /api/v1/requests/:id/manager-approve`, `POST /api/v1/requests/:id/manager-reject`
- `POST /api/v1/admin/requests/:id/final-approve`, `POST /api/v1/admin/requests/:id/final-reject`, `POST /api/v1/admin/requests/bulk-final-approve`
- `GET /api/v1/admin/provider-balances`, `GET /api/v1/admin/wallet/transactions`, `GET /api/v1/admin/payouts`
- `POST /api/v1/admin/payment-links`, `GET /api/v1/admin/payment-links`, `POST /api/v1/admin/payment-links/:id/disable`
- Public token routes: `GET /api/v1/public/payment-links/:token`, `POST /api/v1/public/payment-links/:token/attempts`, `GET /api/v1/public/payment-links/:token/status`
- Provider-specific signed webhook ingress kept separate from public/browser routes.
- `GET /api/v1/admin/reports/...` plus export endpoints or asynchronous export jobs as volume requires.

Use Joi schemas, bounded pagination, allowlisted sort columns, explicit status filters, idempotency keys for state-changing financial operations, and stable error codes. Public routes need strict rate limits, anti-enumeration behavior, active/disabled-link checks, and no internal database identifiers in responses.

## Reports and exports

Reports must use server-side authorization, filtering, sorting, and pagination. Support today, yesterday, this month, last month, and custom date range in Africa/Lusaka time. Convert each selected local range into UTC `[start, end)` bounds to avoid double-counting midnight records. Sort newest first by default with a deterministic ID tie-breaker.

Initial reports: PawaPay-reported wallet balance snapshots, app reservations and treasury-ledger payout/collection entries, provider settlement/fee reconciliation, expense requests by state/category/requester, and payment-link collections with provider references. Offer CSV/XLSX and PDF. Exports use the same filters and authorization as the screen, record who generated them, escape spreadsheet formula-leading cells, and avoid logging attachment contents or unnecessary phone data. Use streaming or queued generation for large exports.

## Security, reliability, and operations

- Password/session handling and MFA for administrators should follow a reviewed policy; use secure, httpOnly cookies or a documented token strategy, CSRF defenses where applicable, rate limits, and session revocation.
- Scope all reads and writes; validate ownership/team scope and prevent IDOR. Use least-privilege database credentials and private object storage with short-lived access URLs for evidence.
- Validate MIME type and actual file content, cap upload size/count, randomize object keys, strip image metadata where appropriate, and consider malware scanning.
- Keep provider secrets server-side, load from managed environment/secret storage, redact logs, verify webhook signatures against raw request bytes, and deduplicate events.
- Use database transactions, constraints, idempotency, row locks/optimistic conflicts, audit records, and operational reconciliation for every financial state change.
- Monitor pending/verification-required attempts, webhook failures, export failures, unusual approval patterns, and ledger balance invariants. Define backup/restore and migration rollback procedures before deployment.
- Start with one deployment and one database. Measure before adding queues/caches; use a durable job mechanism for exports or provider polling only when required.

## Delivery phases

### Backend Phase 1 — standalone API foundation, identity, categories, requests

Create a separate Node/Express API and PostgreSQL database in `back/`. Add a dedicated migration runner, health/readiness, validated environment configuration, and authenticated ITC identity/session integration without copying ITC credentials or identities. Add feature-level manager assignments, the approved category hierarchy, private evidence storage, request endpoints, staged decisions, and an audit trail. Do not connect to the ITC database. Do not apply the new Expense Warrior database migration during local scaffolding.

**Acceptance:** an attached manager can see only assigned staff requests; each request follows manager then admin approval (or direct admin if no manager); self-approval is blocked; decisions are durable and concurrency-safe; attachment access is private and scoped.

### Backend Phase 2 — atomic holds, provider balance, and ledger integration

Add narrow authenticated ITC finance endpoints for atomic idempotent holds/releases and one-time collection/payout postings; Expense Warrior must not write directly to ITC storage. Add signed PawaPay balance reads and snapshots in Expense Warrior, provider attempts, reconciliation, and recovery. Keep request categories independent of ITC generic expense categories, with an explicit audited mapping for payout posting. Resale inventory requires the stock-receiving workflow, not an OPEX-only expense posting.

Status: hold reservation/release, admin provider-balance reads, signed ITC ledger reads, payout execution/recovery, and admin-only bulk approval are implemented in source. ITC payout consume is source-complete; migration 134 objects are present in `itc` and `local_staging`, but exact ledger/checksum evidence is incomplete, so payout calls remain disabled. Expense Warrior migrations 0001–0012 are applied to the dedicated local database with matching checksums. Provider balance snapshots have an append-only migration, repository, admin history route, service integration, and wallet UI; database persistence is now available locally. Signed callback intake is source-complete but disabled by default; it is a durable hint inbox, not payment evidence or a posting path.

**Acceptance:** manager approval reserves funds in ITC once; final admin payout consumes that reservation exactly once after verified provider success; failed payouts release ITC holds; unknown outcomes retain holds; provider-reported balance, ITC holds, and ITC ledger totals remain separately visible and auditable.

### Backend Phase 3 — PawaPay payouts and reusable payment links

Add non-expiring, admin-disableable fixed-amount public link tokens that accept multiple payments; normalized deposit/payout contracts; PawaPay adapter; network capability config; provider status and wallet-balance access; webhook inbox; recovery/reconciliation; and exactly-once per-attempt ITC credit/posting. Reuse the Shop.IT PawaPay client patterns selectively; keep Expense Warrior request authorization and provider attempts isolated.

**Acceptance:** only confirmed, identity/amount/currency-matched provider success is applied; one attempt cannot be applied twice; a reusable link can have multiple distinct successful payments; unknown outcomes stay unresolved; callbacks are authenticated, deduplicated hints; receipts are per payment.

Status: source includes reusable fixed-amount links, public PawaPay deposit/status polling, exact provider-result validation, retryable `VERIFIED_PENDING_LEDGER` attempts, success receipts only after ITC applies the posting, and admin target selection for revenue, customer credit, or A/R. The isolated ITC integration worktree now contains eligible delivered-invoice listing, one-at-a-time full-balance reservations, definitive provider-failure releases, and atomic verified A/R collection against account 1100; Expense Warrior reserves before PawaPay and closes all links for an invoice after ITC confirms collection. ITC migrations 136–137 are source-only and unapplied, so A/R collections remain disabled operationally pending an approved release and database verification. Expense Warrior migration 0012 is applied to its dedicated local database. ITC migrations 134–135 have expected schema objects in both requested databases, but their ledger/checksum evidence is incomplete. No provider calls have been made.

### Backend Phase 4 — reports, exports, and hardening

Add role-scoped reports, Africa/Lusaka date windows, deterministic sorting/pagination, CSV/XLSX/PDF generation, export audit, monitoring, operational reconciliation and security/performance review.

**Acceptance:** report totals reconcile to ledger rows; timezone boundaries are correct; exports cannot bypass filters or permissions; large exports have bounded resource use.

## Decisions required before implementation

1. Define insufficient provider balance behavior and hold expiry/escalation. Payout destinations are admin-managed in V1 and snapshotted to requests.
2. Define who assigns/changes a staff user's manager and how requests already in review behave when the assignment changes. Decide whether admins may submit requests and, if so, require a second admin approver.
3. Verify the sandbox account token and permissions for deposits, payouts, wallet balances, and callbacks. Shop.IT's canonical PawaPay client currently handles deposits/refunds; its existing payout model is closely tied to supplier/vendor/payroll accounting, so Expense Warrior needs its own payout service boundary.
4. Confirm per-network sandbox onboarding/config, limits, payout funding/balance semantics, failure behavior, and phone normalization against the sandbox account.
5. Confirm Cloudinary retention/access policy, email/SMS notifications, and export retention.
6. Confirm the accounting treatment for each approved category. Resale inventory must use the stock-receiving workflow; do not post it as an operating expense or expose it as payable until that link is designed.

## Validation gates

Plan security and domain tests around authorization/IDOR, concurrent and duplicate decisions, bulk partial conflicts, duplicate payout retries, ledger reversal, provider timeout/unknown status, duplicate/out-of-order webhooks, wrong amount/currency/reference, disabled/reused links, phone/network validation, timezone boundaries, spreadsheet formula injection, and export authorization. Use provider documentation and isolated sandbox evidence; do not make live payments while implementing or validating this plan.
