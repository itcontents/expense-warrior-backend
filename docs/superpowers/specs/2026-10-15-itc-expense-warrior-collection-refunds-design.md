# ITC refunds for Expense Warrior A/R collections

**Status:** owner-approved first-class collection source (2026-10-16); source implementation is gated and not database-verified

## Goal

Let ITC process an approved return for a delivered credit invoice that Expense Warrior fully settled through a verified PawaPay payment-link collection. ITC must identify the exact collection as the refund source and keep its existing provider verification, return policy, treasury, and accounting ownership.

## Scope

This applies only to credit invoices whose A/R balance reached zero through a verified `AR_SETTLEMENT` collection operation. A return against an invoice with an outstanding A/R balance continues to use the existing credit-note flow. Revenue links and unapplied customer-credit links are not return-refund sources in this change. Storefront prepaid orders and their current payment/refund path remain unchanged.

No database migration is applied, no provider call is made, and no refund is initiated while implementing this design. The new ITC migration and feature gate remain source-only until the owner authorizes a release.

## Domain model

A refund has one immutable source. Model it as a tagged source:

- `CANONICAL_PAYMENT`: the current order-payment flow, identified by canonical payment and provider attempt.
- `EXPENSE_WARRIOR_COLLECTION`: an A/R payment-link collection, identified by the ITC `expense_warrior_collection_operations.operation_id`.

Do not create synthetic rows in storefront `payments` or `payment_attempts`. They would falsely make an A/R settlement look like a storefront checkout and would blur payment ownership.

The collection source must resolve to exactly one immutable ITC collection operation with target `AR_SETTLEMENT`, the same receivable, customer, order, currency, amount, PawaPay provider, original provider deposit ID, and the PawaPay provider-account ID/version used when the deposit was collected. ITC must verify the original deposit under that same account/version before a refund can be submitted. If ITC cannot establish the original account identity, fail closed. Existing collection operations lack account/version metadata and are not eligible until independently reconciled and explicitly backfilled under a separate approved procedure.

## Return eligibility and state

A delivered `CREDIT` invoice has two return outcomes:

1. If its receivable has a positive outstanding balance and no active collection reservation, preserve the current approval path: post one credit note against A/R. Do not send cash.
2. If the receivable is settled by a verified Expense Warrior A/R collection, approve the return into the existing `APPROVED` state and use the existing refund request/outbox/reconciliation lifecycle with the collection operation as the source.

Reject a return if the receivable is reserved, has inconsistent status and balance, lacks an exact collection event, was settled by a different payment source, or has already been refunded beyond the approved return allocation.

The existing return-review segregation rule remains: the approver cannot initiate the refund. Provider callbacks remain hints. Only a verified terminal provider refund may complete the refund and trigger accounting.

## Persistence and transaction boundaries

Extend `expense_warrior_collection_operations` with nullable provider-account ID/version columns for legacy compatibility; new operations require both. Extend `payment_refund_requests` with an explicit source discriminator and nullable collection-operation foreign key. Preserve existing payment/attempt references for `CANONICAL_PAYMENT` rows. Add a check constraint that requires exactly the source-specific identifiers for each discriminator and rejects mixed or missing identities. Add bounded indexes for source-operation refund reconciliation. Migration must validate existing refund rows before adding constraints and must never rewrite historical refund identity.

Keep the existing unique refund-per-return idempotency key. Serialize return approval/refund initiation against the order, receivable, collection operation, and existing refund requests. Cap the cumulative requested, submitted, completed, or unresolved refunds for a collection at its verified amount. Failed or cancelled requests release the cap only after ITC's existing reconciliation rules confirm that state; unknown outcomes remain reserved.

The refund request and outbox event are created in one ITC transaction. Provider initiation remains asynchronous and uses the original PawaPay deposit ID. Retries reuse the refund request ID. An unknown result never creates a second provider refund.

## Accounting

Reuse the existing return-line pricing, zero-TOT-tax gate, dispatch allocation evidence, returned-stock inspection, and COGS reversal checks. For a collection-sourced refund, reconcile against the original ITC collection operation and its immutable treasury receipt/journal evidence rather than requiring a synthetic storefront finance-ledger receipt.

On verified refund completion, post the cash outflow against the original PawaPay clearing treasury and reverse revenue using the existing refund account policy. Reverse COGS and restore inventory only for accepted saleable goods, using the existing FIFO return path. Do not reopen A/R: the invoice was settled before the refund. Post the refund records, treasury movement, journals, return state, and completion outbox event atomically and idempotently. A mismatch or missing source journal leaves the return in accounting exception and does not report financial completion.

## Interfaces and ownership

The existing authenticated ITC Backoffice return routes remain the user-facing workflow. ITC owns refund request state, provider work, and accounting. Expense Warrior remains the owner of payment-link attempts and posts the original collection through the signed ITC finance API; ITC reads its immutable collection operation as the refund source. No Expense Warrior-to-ITC database access is added.

The ITC provider integration must use the same PawaPay merchant account that accepted the original deposit. Resolve that account from ITC's trusted provider configuration, never from a browser or an untrusted request field. If the account identity/version cannot be proven for the deposit, hold the refund for reconciliation instead of using the currently active account by assumption.

## Release gates

- Add an ITC feature gate, default off, for collection-sourced return refunds.
- Author a guarded additive migration for the source discriminator and collection-operation relationship. Do not apply it during source work.
- Keep Expense Warrior collection and payout flags off until ITC migration ledger/checksum evidence, account mappings, provider account identity, and signed-request-only configuration are verified.
- Keep A/R collection disabled while account 1100 is inactive or non-postable.
- Before enabling, run disposable-PostgreSQL transaction, concurrency, and replay checks plus an authorized sandbox refund test. Do not create a live transaction during development.

## Implementation status (2026-10-16)

- ITC source code now has a tagged A/R collection refund path through return approval, provider submission/reconciliation, treasury posting, and accounting replay validation.
- `EXPENSE_WARRIOR_COLLECTION_REFUNDS_ENABLED` defaults to `false`; `.env.example` keeps it off.
- Migration 139 remains source-only. It also defines the guarded collection-refund treasury writer; it has not been applied.
- Focused node:test coverage passes for source selection, provider payload identity, release gating, settled return approval, migration shape, and replay evidence.
- Disposable-PostgreSQL transaction/concurrency tests and an authorized PawaPay sandbox refund are still required before enabling the feature.

## Required verification

Tests must prove that unpaid credit-invoice returns still create credit notes; settled A/R returns select the exact collection source; mixed, missing, wrong-customer, wrong-invoice, wrong-provider, wrong-deposit, and wrong-amount sources fail closed; duplicate and concurrent refunds cannot exceed the collection amount; unknown provider results retain the source reservation; verified completion posts once; and a replay validates treasury, journal, refund, allocation, and inventory evidence without writing duplicates.
