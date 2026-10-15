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

- [ ] Write a schema test proving legacy rows map to `CANONICAL_PAYMENT`, A/R refunds require exactly one collection operation, and mixed source identities are rejected.
- [ ] Run `node --test tests/expenseWarriorCollectionRefundMigration.test.js`; confirm the new migration is absent and the test fails for the expected missing artifact.
- [x] Add additive DDL and guarded release registration without applying the migration.
- [ ] Run the migration schema test and all migration-manifest tests.
- [ ] Commit the migration source and registration as one unit.

### Task 2: Resolve settled-credit return source and eligibility

**Files:**
- Modify: `src/services/returnEligibilityPolicy.js`
- Modify: `src/services/returnRefundWorkflowService.js`
- Modify: `src/models/returns/ReturnRequestModel.js`
- Test: `tests/returnEligibilitySafety.test.js`
- Test: `tests/returnReceivableGuard.test.js`
- Test: `tests/creditReturnApprovalTransaction.test.js`
- Test: `tests/creditReturnApprovalTransaction.test.js`

**Interfaces:**
- `requestApprovedRefund({ returnRequestId, actorId, reason })` selects `CANONICAL_PAYMENT` or `EXPENSE_WARRIOR_COLLECTION` from authoritative ITC rows.
- A settled credit return source includes collection operation ID, receivable ID, customer ID, order ID, provider code, original deposit ID, amount, and currency.

- [ ] Add failing behavior tests for outstanding receivables, settled A/R collections, active reservations, missing source operations, and wrong-source identity.
- [ ] Run those tests and confirm they fail because settled credit returns are currently rejected or routed to credit notes.
- [ ] Implement the two-path approval decision: outstanding A/R uses a credit note; a fully settled verified A/R collection uses the refund lifecycle.
- [ ] Run the focused return policy and transaction tests.
- [ ] Commit return eligibility and source selection.

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

- [ ] Add failing tests for source-aware payload, source identity mismatch, same-ID retry, and unknown outcome recovery.
- [ ] Run the focused worker tests and confirm the source collection path is missing.
- [ ] Implement the worker branch using ITC's trusted provider account configuration and reject an unprovable account/deposit association.
- [ ] Run all refund worker tests.
- [ ] Commit source-aware refund initiation and recovery.

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

- [ ] Add failing tests for valid source collection, missing/mismatched source evidence, cumulative over-refund, balanced journal, FIFO restoration, and write-free valid replay.
- [ ] Run the focused accounting tests and confirm collection-source behavior is absent.
- [ ] Implement the collection-source branch without changing the existing canonical-payment branch.
- [ ] Run all refund accounting and credit-return tests.
- [ ] Commit the accounting and replay guard.

### Task 5: Gate and validate the complete source-only workflow

**Files:**
- Modify: `src/config/env.js`
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Modify: `docs/credit-return-settlement-and-refunds.md`
- Test: `tests/expenseWarriorCollectionRefundRoutes.test.js`
- Test: disposable-PostgreSQL transaction/concurrency test suite

- [ ] Add a default-off `EXPENSE_WARRIOR_COLLECTION_REFUNDS_ENABLED` gate and test disabled, incomplete readiness, and enabled-source configurations.
- [ ] Verify existing authenticated admin routes expose no new public refund surface.
- [ ] Run the focused route tests and all affected return, refund, accounting, and migration-manifest tests.
- [ ] Run the full backend suite and disposable-PostgreSQL transaction/concurrency/replay suite without applying migration 139 to shared databases.
- [ ] Update documentation with source-only status and external release blockers.
- [ ] Commit the gate, tests, and status documentation.
