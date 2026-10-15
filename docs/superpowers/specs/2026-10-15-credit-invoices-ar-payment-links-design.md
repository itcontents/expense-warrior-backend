# Credit invoices and A/R payment links — Expense Warrior V1

**Status:** Architecture approved by the owner; source implementation in progress with release prerequisites outstanding. **Date:** 2026-10-15. **Scope:** Add admin-created credit invoices and full-balance payment-link settlement across ITC and Expense Warrior.

## Context and decisions

Expense Warrior has a separate API and PostgreSQL database for requests, approvals, payment links, provider attempts, and workflow audit. ITC remains authoritative for customer identity, orders, inventory, chart of accounts, treasury, journals, and financial posting. ITC A/R APIs and Expense Warrior integration are implemented in source; the required guarded migrations have not been applied, so A/R remains unavailable operationally until release verification.

The owner approved an admin-only credit quote conversion, delivery on credit, A/R beginning at dispatch, delivered invoices only as A/R link targets, full-balance payment links that close after settlement, and credit-note handling for returns. Normal quote conversion and storefront orders remain full-payment-only and unchanged. Revenue, TOT, stock, and COGS continue to follow ITC's current dispatch policy. VAT-bearing credit orders remain blocked until VAT handling is defined.

## Implementation status (2026-10-15)

Source code for credit quote conversion, dispatch-time receivable recognition, ITC receivable listing and reservation APIs, and Expense Warrior A/R link collection is implemented and covered by focused tests. ITC migrations 136 and 137 remain unapplied; the A/R feature must stay disabled until the target database migration state and account 1100 readiness are verified and the guarded release is completed. Credit-note/return accounting is not implemented yet, so credit invoices are not ready for live use. No migration, provider call, credit dispatch, or financial posting was performed as part of this source implementation.

## Goals

- Allow an ITC admin to explicitly convert an eligible backoffice quote to a credit order.
- Allow delivery before the credit order is paid while preserving stock reservations and dispatch controls.
- Create and maintain an authoritative ITC receivable only at dispatch.
- Let an Expense Warrior admin create a fixed ZMW link for the full outstanding balance of a delivered invoice.
- Collect through PawaPay without exposing ITC credentials or direct database access to Expense Warrior or the browser.
- Prevent duplicate or concurrent settlement, retain reservations on unknown outcomes, and issue receipts only after verified provider success and ITC posting.
- Handle approved returns through a credit note for unpaid invoices or the verified collection refund path for paid invoices.

## Non-goals

- Partial A/R payments, split tender, or payment before dispatch.
- Storefront or ordinary cash-quote credit terms.
- VAT classification or VAT-bearing credit invoices.
- A/R posting or invoice selection in Expense Warrior's database.
- A new receivables-aging report; the new collection remains visible in the existing ITC-backed wallet history and its authorized exports.
- Automatic expiry of an undelivered credit order's stock reservation.
- Replacing the existing provider registry or adding a second provider in V1.

## Architecture and ownership

```text
Admin/backoffice ── credit quote/order workflow ── ITC backend + PostgreSQL
                                                        │
Payer browser ── public Expense Warrior page ── Expense Warrior API + PostgreSQL
                                                   │         │
                                                   │         └── PawaPay adapter
                                                   │               deposits/status/balance
                                                   └── signed ITC finance service
                                                         receivables/reservations/posting
```

- ITC owns credit-order markers, dispatch eligibility, receivables, receivable events, payment reservations, allocations, journals, inventory and all authoritative balances.
- Expense Warrior owns opaque public-link tokens, link metadata, local collection attempts, provider routing, provider evidence, UI-facing status and a reconciliation mirror of ITC operation IDs/states.
- No shared database, distributed transaction, or browser-to-ITC finance call is introduced. Use signed service APIs with HMAC authentication, timestamp window, single-use nonce, actor attribution, request IDs and idempotency keys.
- Keep PawaPay behind the existing operation-capability provider registry in Expense Warrior. ITC receives verified provider evidence and performs the financial posting; Expense Warrior never posts or calculates A/R.

## Credit quote and dispatch workflow

1. An authorized ITC admin selects an explicit **Convert to credit order** action on an eligible backoffice quote. The ordinary conversion path is not altered. The credit conversion records an immutable credit-sale marker and does not create a payment receipt.
2. The order reserves inventory with no automatic expiry. Existing stock availability, source-backed cost and dispatch preconditions still apply. An admin may cancel before dispatch, releasing that reservation. Any later return follows the credit-note path.
3. Dispatch is permitted for the marked credit order without a payment. The existing dispatch transaction consumes the stock reservation, updates fulfillment, writes sale/COGS/stock journals and creates one receivable. All effects commit or roll back together.
4. The credit dispatch journal debits Trade Receivables (1100) instead of Customer Advances (2000). Product/delivery revenue and TOT treatment follow the current dispatch policy; COGS and inventory issue follow the current source-evidence rules. Existing paid-order journals and receipt handling remain unchanged.
5. ITC writes one receivable keyed to the credit order, with customer, invoice/order reference, currency, original amount, outstanding amount, dispatch time and status. Immutable receivable events record the dispatch debit, collection allocations, credit notes and any supported correction/reversal. Retries cannot create a second receivable or journal.

The ITC database change must be additive and guarded. It must add the receivable, immutable event, payment-reservation, allocation and credit-note records with stable source keys, uniqueness constraints, foreign keys and lookup indexes. It must verify that account 1100 is the expected `ASSET_RECEIVABLE` identity before enabling it for posting; a conflicting identity fails closed. A/R dispatch stays feature-gated until this migration and the workflow are reviewed and enabled.

The order must remain explicitly identifiable as credit throughout quote conversion, reservation, dispatch, return eligibility and reporting. Do not infer credit status from a missing payment row alone.

## Receivable and link rules

- ITC exposes only fully delivered invoices with a positive, collectible ZMW balance. A/R is recognized at dispatch, but the invoice is not link-eligible until delivery is recorded. Undelivered orders and storefront orders are never eligible.
- Expense Warrior stores the ITC receivable ID, selected target, fixed amount snapshot, customer reference needed for service validation and local link metadata. It does not maintain the authoritative balance.
- Admin link creation asks ITC to validate the invoice, customer and current balance. The link amount is the full balance at creation. The link is reusable while that exact balance remains due, has no expiry, and can be disabled by an admin.
- Every payment attempt revalidates and reserves the full current outstanding balance in ITC before PawaPay initiation. ITC serializes reservations per receivable. Only one active A/R payment reservation may exist for an invoice, including when several links point to it.
- If a prior payment, credit note or other authorized change makes the fixed link amount stale, ITC rejects the attempt before the provider call; the admin must issue a new link for the updated balance. Do not silently change a fixed link amount.
- A definitive provider failure releases the same reservation. Timeout, missing callback, or any ambiguous result remains reserved and recoverable; never create a replacement attempt or release the hold based on elapsed time alone.
- Verified success atomically posts the treasury receipt, balanced journal and allocation against the receivable in ITC, reduces the outstanding balance, and marks the receivable settled. ITC then closes every A/R link for that invoice. A provider `ACCEPTED` response or callback alone is not settlement evidence.
- A/R collection is full-balance only in V1. Revenue and customer-credit links retain their existing reusable behavior; customer credit remains a liability and does not create or settle A/R.

## Accounting and returns

- At credit dispatch, debit 1100 Trade Receivables in place of 2000 Customer Advances; post revenue, TOT, COGS and inventory under the existing dispatch rules.
- On a verified A/R collection, debit the PawaPay clearing asset (1020 per the existing mapping) and credit Trade Receivables for the exact amount. Record the allocation, provider evidence and ITC operation in the same transaction as the journal and treasury ledger entry.
- An approved return on an unpaid credit invoice creates one idempotent credit note. It reduces the receivable and reverses applicable revenue. If returned goods are accepted as saleable, restore inventory and reverse the matching COGS; otherwise do not restore saleable stock. Credit-note state, subledger events, inventory, journal and order return state are atomic and auditable.
- Credit-note posting serializes on the same receivable lock as payment reservation/allocation. It cannot change an invoice while a provider result is unresolved; wait for a definitive terminal result or reconcile the attempt first.
- A return after collection uses the existing approved-return and evidence controls, but payment-link collections are not canonical `payments` rows, so they cannot be forced through the storefront refund source lookup. Use a source-specific PawaPay refund attempt tied to the verified collection operation and its original deposit ID. The refund initiation uses a stable refund ID; `ACCEPTED` is pending, and only authoritative terminal success posts the refund accounting. Unknown outcomes remain pending and reconcile against that same refund ID. Never also create an A/R credit note for the same value.
- Do not mutate posted invoices, receivable balances, journals, or inventory history in place. Corrections use linked, idempotent reversal/credit-note events.

PawaPay V2 provides `POST /v2/refunds` with a `refundId`, original `depositId`, amount, currency, and client reference; the initiation API is idempotent by refund ID and returns asynchronous statuses. Final status is read through `GET /v2/refunds/{refundId}` or a verified callback. Expense Warrior now has the signed adapter methods for initiation and status lookup, but the return workflow, durable refund-attempt state, callback routing, and ITC refund posting remain to be implemented before this path is available. See the [official initiation](https://docs.pawapay.io/v2/api-reference/refunds/initiate-refund) and [status](https://docs.pawapay.io/v2/api-reference/refunds/check-refund-status) references.

## Payment page and PawaPay

**Owner decision:** Approved. V1 uses the modular PawaPay adapter, merchant-enabled Zambia deposit networks, server-side phone validation, no PIN collection, signed financial requests, and provider polling before ITC posting. The user-facing receipt appears only after ITC confirms the posting.

- The public page shows the fixed amount due and a safe invoice description, then offers only the configured Zambia DEPOSIT networks. In V1 the intended options are Airtel, MTN and Zamtel, but the merchant's PawaPay active configuration is authoritative for network, currency, transaction limits and authorization instructions.
- Normalize the country-coded phone number server-side. PawaPay provider prediction may warn or ask the payer to confirm a network mismatch; it is not treated as authoritative.
- The browser never collects or stores the payer's mobile-money PIN. PawaPay/mobile money sends any authorization prompt to the payer's handset. Sandbox does not reproduce the production PIN step.
- Store the local attempt and stable UUIDv4 provider ID before the financial POST. Sign deposit and payout requests using the configured HTTP message signature key; production activation requires PawaPay's account-level **signed requests only** setting. Fail closed if signing is unavailable.
- Treat the deposit API as asynchronous. Poll final provider status; accept callbacks only after raw-body signature verification and use them as wake-up hints, not final authority. Match provider ID, reference, amount, currency, country, network and phone to the local attempt before posting.
- On verified provider success, ask ITC to post exactly once. Show success and create a masked PDF receipt only after ITC confirms the collection posting. Pending, failed, mismatched or unposted attempts never show a paid receipt.
- Sandbox validation uses PawaPay's documented Zambia test numbers for successful, failed and no-callback/pending outcomes. Test data is never used in production. Confirm merchant-specific provider enablement and limits separately.

## Internal API boundary

Extend the signed ITC finance API with narrow operations for:

1. Listing eligible delivered receivables with stable pagination and minimal customer/invoice labels.
2. Reading and validating the current receivable target for admin link creation.
3. Reserving the entire receivable balance for one payment attempt using stable operation and idempotency IDs.
4. Releasing only a definitively failed attempt's reservation.
5. Posting a verified PawaPay collection and receivable allocation atomically, or returning the exact prior result on safe replay.
6. Returning operation/reservation status for recovery without creating a new financial operation.

All mutations bind the request fingerprint, actor, invoice, Expense Warrior link/attempt, provider transaction, amount and currency. Duplicate provider transaction, reservation, attempt, or idempotency identity cannot create another posting. Mismatched reuse returns a conflict and preserves the active reservation for reconciliation. Exact endpoint paths and response schemas are an implementation-plan decision after this design is accepted.

## Security, permissions and audit

- ITC session identity authenticates employees/admins; Expense Warrior applies its own roles and manager assignment. Public link access is scoped only by an unguessable hashed token and exposes no internal customer data.
- Only admins create/disable payment links and credit quotes. Only admins can select customer invoices for links and perform final payment/reconciliation actions. Manager/staff request roles and manager-then-admin approval remain unchanged; self-approval stays prohibited; bulk approval remains admin-only.
- Keep customer phone details masked in UI and logs. Provider callbacks are bounded, signature-checked before JSON parsing, deduplicated and stored as minimal evidence.
- Append immutable audit events for credit quote conversion, dispatch, receivable creation, reservation, release, collection, credit note/refund, link close/disable and export/reconciliation actions.

## V1 verification plan

Use unit, integration and disposable-PostgreSQL concurrency tests before enabling the feature:

- Existing paid quote conversion, storefront payment, paid dispatch and paid-return flows remain unchanged.
- Only admin can mark a quote for credit; credit orders cannot create payment receipts before dispatch.
- Credit dispatch with inventory reservation creates exactly one receivable and balanced journals; rollback leaves order, inventory, receivable and ledger unchanged on failure.
- Simultaneous attempts across the same or different links for one receivable yield at most one active reservation and one successful allocation.
- Provider timeout/no callback retains reservation; definitive failure releases once; duplicate/out-of-order callbacks cannot post; exact retries return the same result.
- Wrong invoice, customer, provider transaction, amount, currency, country, network, phone or idempotency fingerprint fails closed before posting.
- Successful full-balance collection posts once, closes all links for the invoice and returns a receipt only after ITC posting. Stale fixed amounts and already-settled invoices are rejected before provider initiation.
- Unpaid returns create one credit note; paid returns use the verified collection refund path; stock/COGS reversal occurs only for accepted saleable goods.
- Verify private/public route permissions, token scoping, phone masking, timezone reporting, export filters, and accounting/receivable reconciliation.

No migration is applied and no sandbox/production payment is initiated as part of design or source validation. New schema, financial operations and feature flags require a separately reviewed implementation plan and explicit readiness review. The current DB verification is documented in [ITC migration 134–135 verification](../../itc-migration-134-135-verification-2026-10-15.md); those two migration checksums still require read-only ledger confirmation, and account 1100 is inactive/non-postable in `local_staging`.

## References

- [Expense Warrior ↔ ITC finance service contract](../../itc-finance-service-contract.md)
- [ITC business and COA policy decisions](../../../../../itcstore-backend/docs/business-and-coa-policy-decisions.md)
- [PawaPay deposit initiation and asynchronous status](https://docs.pawapay.io/v2/api-reference/deposits/initiate-deposit)
- [PawaPay active merchant configuration](https://docs.pawapay.io/v2/api-reference/toolkit/active-configuration)
- [PawaPay provider prediction](https://docs.pawapay.io/v2/api-reference/toolkit/predict-provider)
- [PawaPay signed financial requests](https://docs.pawapay.io/v2/docs/signatures)
- [PawaPay sandbox test numbers](https://docs.pawapay.io/v2/docs/test_numbers)
