# ITC Collection Readiness Preflight

**Date:** 2026-10-18
**Status:** Draft for owner review
**Scope:** Signed read-only readiness check shared by the Expense Warrior API and ITC finance service before initiating non-A/R PawaPay deposits.
**Owner decision:** The owner approved a read-only preflight before provider initiation. This document records the detailed cross-repo contract for review; it does not authorize implementation, migration, or provider calls.

## 1. Problem

Expense Warrior payment links support `REVENUE`, `CUSTOMER_CREDIT`, and `AR_SETTLEMENT` targets. An A/R attempt reserves the receivable through ITC before contacting the provider. Revenue and customer-credit attempts currently contact PawaPay first, then discover during post-success ledger posting whether ITC finance is enabled, the provider account maps to a usable treasury, the configured target is postable, and the actor or customer is still eligible.

If one of those conditions is already false, the payer can complete a mobile-money payment while ITC refuses the accounting post. Expense Warrior retains the verified provider evidence as `VERIFIED_PENDING_LEDGER` and withholds the receipt, so the payment is not silently lost; it still leaves an avoidable reconciliation case.

## 2. Approved design

Add a signed, read-only ITC preflight for `REVENUE` and `CUSTOMER_CREDIT` payment links. Expense Warrior calls it after persisting the local attempt and immediately before submitting a deposit to PawaPay. PawaPay is not called unless ITC confirms readiness.

The existing A/R flow remains unchanged: ITC atomically reserves the full invoice balance before the provider call. The preflight is not an A/R reservation and does not replace that stronger check.

The preflight reduces known setup failures. It cannot hold database state across an external mobile-money prompt, so an administrator can still change mappings or accounts after the check. If that race causes a later post to fail, the existing `VERIFIED_PENDING_LEDGER` recovery remains authoritative and no receipt is issued until ITC posting succeeds.

## 3. API contract

Add `POST /api/v1/internal/expense-warrior/collections/preflight` to the ITC-owned finance router and a matching method to Expense Warrior's `ItcFinanceClient`.

The request is authenticated by the existing ITC service HMAC middleware, including its timestamp, nonce, request-ID, raw-body signature, and replay claim. Use the existing service idempotency header format; the operation is read-only and does not create an idempotency record.

Request body:

```json
{
  "payment_link_id": "<uuid>",
  "collection_attempt_id": "<uuid>",
  "actor_customer_id": "<uuid>",
  "provider_code": "pawapay",
  "provider_account_id": "<uuid>",
  "provider_account_version": 1,
  "target": {
    "type": "REVENUE",
    "revenue_account_code": "4000"
  }
}
```

For `CUSTOMER_CREDIT`, `target` contains `type` and `customer_id` instead. Reject unknown fields, unsupported target types, invalid UUIDs, invalid provider codes, and malformed account versions. A/R must be rejected by this endpoint and continue through the reservation API.

Ready response:

```json
{ "success": true, "data": { "ready": true } }
```

Readiness failures use the ITC service's standard safe error envelope with a stable error code. The response contains no balances, phone data, credentials, or database/provider messages. Expense Warrior retains the stable code internally for safe recovery and does not render arbitrary ITC text.

## 4. Readiness checks

In one `REPEATABLE READ READ ONLY` transaction, ITC checks:

1. Expense Warrior finance integration is enabled and correctly configured.
2. The supplied provider account exists, is enabled for new payments, is `READY`, has the expected provider, treasury mapping, and exact version.
3. The mapped treasury and its chart account are active, postable ZMW mobile-money clearing accounts supported for that provider.
4. The actor is an active ITC admin.
5. For `REVENUE`, the selected account is an active, postable revenue account.
6. For `CUSTOMER_CREDIT`, the customer is an active customer account and dedicated account 2020 is an active, postable customer-credit liability account.

The transaction issues no DDL, DML, row locks, ledger writes, reservations, or durable audit rows. It is ended with rollback. No ITC database is queried by Expense Warrior directly.

## 5. Expense Warrior attempt behavior

For `REVENUE` and `CUSTOMER_CREDIT` only:

1. Preserve the existing idempotency fingerprint and persist the attempt before provider initiation.
2. Call ITC preflight using the persisted attempt's provider-account snapshot and payment-link target.
3. On `ready: true`, submit the existing provider deposit request with the same transaction ID and signed-request enforcement.
4. On a definitive readiness rejection, set the attempt to terminal `FAILED` with an internal preflight error code; do not call PawaPay. The public payment view can offer “Try another payment,” which creates a new attempt identity.
5. On an ITC timeout/unavailable response, also record a terminal local failure: because the provider call has not been made, the outcome is known and must not be labeled as an unknown provider payment. A new attempt may retry after service recovery.
6. Replaying an already stored attempt with the same idempotency identity must not repeat a provider deposit. Existing attempt-level uniqueness remains authoritative.

For `AR_SETTLEMENT`, continue to reserve the full outstanding amount in ITC before provider initiation. For all targets, a verified provider success is still polled and evidence-matched before the existing idempotent ITC posting call. If posting fails after readiness passed, retain `VERIFIED_PENDING_LEDGER`; do not issue a receipt or create another provider attempt automatically.

## 6. Security and financial invariants

- Only the internal signed service client can call ITC preflight; the public payer page never calls ITC directly.
- Do not ask for or store a mobile-money PIN. The provider sends the authorization prompt.
- Do not bypass PawaPay request signing, the account-level signed-requests-only gate, provider identity snapshots, authoritative polling, evidence matching, or ITC's atomic posting path.
- Readiness does not move money or recognize revenue/customer credit. Only verified provider evidence followed by successful ITC posting changes financial state.
- Failure before provider initiation is known-safe to retry with a new attempt identity. Provider-accepted, unknown, or verified-but-unposted attempts retain the existing non-duplicate recovery rules.
- No schema migration is required for this read-only check.

## 7. Validation contract

Focused tests must prove:

- ITC rejects malformed requests and A/R targets without querying readiness tables.
- ITC readiness executes in a read-only transaction and evaluates every check above, including the provider-account version and `READY` state.
- Invalid HMAC, expired timestamp, nonce replay, and missing service configuration never reach readiness checks.
- Expense Warrior sends preflight only for revenue/customer-credit targets and sends no provider deposit when ITC rejects or is unavailable.
- A successful preflight is followed by exactly one provider request; a same-key replay does not send a second deposit.
- A/R attempts continue to reserve before the provider call and do not use preflight as a substitute.
- A later ledger-post failure remains `VERIFIED_PENDING_LEDGER`, exposes no receipt, and retries the same ITC post identity after the underlying issue is fixed.
- No test calls a live or sandbox provider and no validation step applies a database migration.

## 8. Risks and limitations

- **Readiness race:** settings can change after the check. The existing verified-pending-ledger recovery handles this; preventing the race fully would require a persistent ITC reservation/lifecycle, which is explicitly not this design.
- **Availability:** the payer cannot start a non-A/R payment when ITC is unavailable. This is intentional fail-closed behavior before charging.
- **Operational evidence:** local environment flags and key files do not prove PawaPay's account-level signed-requests-only setting. Production enablement still requires account-level confirmation.
- **Account readiness:** existing evidence shows account 1100 is inactive and non-postable in `local_staging`, and the approved reader cannot inspect the `itc` migration ledger. This preflight does not repair those separate ITC readiness gates and does not make A/R available.

## 9. Out of scope

- Implementing or applying ITC migrations, including adoption/tracking writes.
- Changing finance enablement, provider-account configuration, account mappings, or chart-of-accounts state.
- Initiating a PawaPay sandbox or production payment.
- Replacing A/R reservation behavior or changing ITC ledger posting semantics.
- Changing authentication, public payment-link reuse/expiry, or receipt behavior.
