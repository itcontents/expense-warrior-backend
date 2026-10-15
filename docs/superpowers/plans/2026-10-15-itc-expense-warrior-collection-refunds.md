# ITC Expense Warrior collection refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Process ITC returns for fully settled Expense Warrior A/R collections through the existing verified refund workflow, without synthetic storefront payment records.

**Architecture:** ITC stores a tagged refund source that points either to the current canonical order payment or an immutable Expense Warrior collection operation. New collection operations record the PawaPay account ID/version used for the original deposit. The return workflow, provider worker, and accounting completion path branch on that source while preserving ITC transaction, outbox, treasury, and idempotency boundaries.

**Tech Stack:** Node.js, Express, PostgreSQL migrations, node:test, existing ITC PawaPay integration and finance models.

**Spec:** [ITC refunds for Expense Warrior A/R collections](../specs/2026-10-15-itc-expense-warrior-collection-refunds-design.md)

## Global Constraints

- Keep every migration source-only. Do not apply migrations.
- Do not initiate provider operations during implementation or validation.
- Keep Expense Warrior collection and payout flags disabled.
- ITC remains the source of truth for returns, refunds, treasury, and accounting.
- Do not create synthetic `payments` or `payment_attempts` for A/R collections.
- Unknown provider outcomes retain the original refund identity and cannot create a replacement refund.
- Reject collection refunds unless ITC verifies the same PawaPay merchant account and original deposit identity.
- Preserve the unpaid credit-invoice credit-note flow and prepaid storefront refund flow.

## Review Focus

1. Two concurrent returns against one collection must not reserve more than the verified amount. Pin with a disposable-PostgreSQL concurrency test.
2. A collection with the wrong customer, receivable, order, provider, deposit, or amount must not be used. Pin with source-identity policy and model tests.
3. A PawaPay timeout must retain the same refund ID and must not submit a second refund. Pin with worker recovery tests.
4. A replay must validate the exact collection receipt, accounting journals, allocations, and stock evidence without inserting duplicate postings. Pin with replay model tests.
5. Existing prepaid and unpaid-credit return paths must retain their current behavior. Pin with existing plus regression tests.

## Progress and validation (2026-10-15)

- Source implementation for Tasks 1–4 is committed in ITC backend commits `e688342` and `6db35b7`; migration 139 remains unapplied.
- Focused source, workflow, provider-contract, replay, return-eligibility, and receivable-guard tests passed: 39/39.
- The ITC smoke suite passed with all its database calls stubbed. Its startup-only DB probe attempted localhost using a dummy test role and was rejected before any SQL ran; it did not connect to `itc` or `local_staging`.
- Disposable-PostgreSQL transaction/concurrency validation has not run. Production/sandbox refund initiation and migrations remain gated and unverified.
- Collection and payout feature flags remain off in Expense Warrior. No provider operation or financial posting was initiated.

---

### Task 1: Define source-tagged refund identity and guarded migration

**Files:**
- Create: `src/migrations/139_expense_warrior_collection_refunds.sql`
- Modify: `scripts/apply_commerce_lifecycle_foundation.js`
- Modify: `scripts/run_commerce_release_migrations.sh`
- Modify: `scripts/validate_commerce_release_artifacts.js`
- Modify: `scripts/database-bootstrap-manifest.json`
- Modify: existing release safety tests whose cumulative migration guard changed
- Test: `tests/expenseWarriorCollectionRefundMigration.test.js`

**Interfaces:**
- Adds `refund_source_type` with values `CANONICAL_PAYMENT` and `EXPENSE_WARRIOR_COLLECTION`.
- Adds nullable `expense_warrior_collection_operation_id` referencing `expense_warrior_collection_operations(operation_id)`.
- Adds nullable `provider_account_id` and `provider_account_version` to old collection operations; new collection posting must supply both values from verified PawaPay initiation evidence.
- Existing refunds default to `CANONICAL_PAYMENT`; source-specific required and forbidden columns are enforced by a validated check constraint.

- [x] Write a source test pinning the legacy default, source-specific identifiers, and original PawaPay account/version fields.
- [x] Run the migration test red first, then pass it after implementing the schema.
- [x] Add additive DDL and guarded release registration without applying the migration.
- [x] Run migration schema, release-artifact, and runner-safety tests.
- [x] Commit the migration source and registration as one unit (`e688342`).

### Task 2: Resolve settled-credit return source and eligibility

**Files:**
- Modify: `src/services/returnEligibilityPolicy.js`
- Modify: `src/services/returnRefundWorkflowService.js`
- Modify: `src/models/returns/ReturnRequestModel.js`
- Modify: `src/services/expenseWarriorFinanceService.js` to persist only ITC-validated A/R collection account identity
- Modify: `back/src/paymentLinks/publicPaymentService.js`, repository, provider registry, env, and migration to snapshot account identity on A/R attempts
- Test: `tests/returnEligibilitySafety.test.js`
- Test: `tests/returnReceivableGuard.test.js`
- Test: `tests/creditReturnApprovalTransaction.test.js`
- Test: `back/tests/publicPaymentService.test.js`, `back/tests/paymentLinkProviderAccountMigration.test.js`

**Interfaces:**
- `requestApprovedRefund({ returnRequestId, actorId, reason })` selects `CANONICAL_PAYMENT` or `EXPENSE_WARRIOR_COLLECTION` from authoritative ITC rows.
- A settled credit return source includes collection operation ID, receivable ID, customer ID, order ID, provider code, original deposit ID, amount, and currency.

- [x] Add behavior tests for outstanding receivables, settled A/R collections, active reservations, missing source operations, and wrong-source identity.
- [x] Implement the two-path approval decision: outstanding A/R uses a credit note; a fully settled verified A/R collection uses the refund lifecycle.
- [x] Run the focused return policy and transaction tests (39 focused tests passed on 2026-10-15).
- [x] Commit return eligibility and source selection (`6db35b7`).

### Task 3: Make refund requests, provider worker, and recovery source-aware

**Files:**
- Modify: `src/services/returnRefundWorkflowService.js`
- Modify: `src/services/paymentRefundWorker.js`
- Modify: `src/services/refundCompletionService.js`
- Test: `tests/paymentRefundWorkerDb.test.js`
- Test: `tests/refundCompletionReplay.test.js`

**Interfaces:**
- A refund request stores its source type and immutable collection operation reference.
- Provider submission uses the source collection's original provider and PawaPay deposit ID, with the same persisted refund request ID on retry.
- Reconciliation preserves `UNKNOWN`/`RECONCILIATION_REQUIRED` states and never submits a replacement automatically.

- [x] Add tests for source-aware payload, source identity mismatch, same-ID retry, and unknown outcome recovery.
- [x] Implement the worker branch using ITC's trusted provider account configuration and reject an unprovable account/deposit association.
- [x] Run focused worker tests as part of the 39-test validation.
- [x] Commit source-aware refund initiation and recovery (`6db35b7`).

### Task 4: Post and replay collection-sourced refund accounting

**Files:**
- Modify: `src/services/refundAccountingService.js`
- Modify: `src/services/refundAccountingReplayGuard.js`
- Modify: `src/services/refundCompletionService.js`
- Test: `tests/dispatchAccountingDb.test.js`
- Test: `tests/refundAccountingReplayGuard.test.js`
- Test: `tests/refundCompletionReplay.test.js`

**Interfaces:**
- `postOnlineRefundAccounting({ client, refund, actorId })` uses the canonical payment receipt for `CANONICAL_PAYMENT`, or the exact ITC collection operation and source receipt/journal for `EXPENSE_WARRIOR_COLLECTION`.
- Both paths return only after the balanced treasury/journal and return allocation evidence commits atomically.

- [x] Add tests for valid source collection, missing/mismatched source evidence, cumulative over-refund, accounting balance, and write-free valid replay.
- [x] Implement the collection-source branch without changing the existing canonical-payment branch.
- [x] Run focused accounting and credit-return tests as part of the 39-test validation.
- [x] Commit the accounting and replay guard (`6db35b7`).

### Task 5: Gate and validate the complete source-only workflow

**Files:**
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Modify: `docs/credit-return-settlement-and-refunds.md`
- Test: `tests/expenseWarriorCollectionRefundRoutes.test.js`
- Test: disposable-PostgreSQL transaction/concurrency test suite

- [x] Add a default-off `EXPENSE_WARRIOR_COLLECTION_REFUNDS_ENABLED` gate and test that refunds remain disabled by default.
- [x] Keep the refund initiation on the existing authenticated return workflow; no public refund route was added.
- [x] Run the focused return, refund, accounting, provider-contract, replay, and migration tests (39 passed).
- [ ] Run the full backend suite and disposable-PostgreSQL transaction/concurrency/replay suite without applying migration 139 to shared databases.
- [x] Update documentation with source-only status and external release blockers.
- [x] Commit the gate and implementation (`6db35b7`); this progress record documents the validation performed afterward.
