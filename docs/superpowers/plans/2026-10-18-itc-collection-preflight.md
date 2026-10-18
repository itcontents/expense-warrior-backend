# ITC Collection Readiness Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent revenue and customer-credit payment links from initiating a PawaPay deposit until ITC confirms the collection target is ready to post.

**Architecture:** Add a signed, read-only readiness endpoint to ITC's existing Expense Warrior finance module. Expense Warrior calls that endpoint after persisting a public collection attempt and before the provider request; A/R links retain their current atomic reservation path. No database migration is required.

**Tech Stack:** Node.js CommonJS, Express, Joi, PostgreSQL `pg`, HMAC service authentication, Node built-in test runner, Vue/Vite Playwright preview.

**Spec:** [ITC Collection Readiness Preflight](../specs/2026-10-18-itc-collection-preflight-design.md)

## Global Constraints

- The preflight is signed by ITC's existing service HMAC middleware.
- The ITC check runs in one `REPEATABLE READ READ ONLY` transaction and performs no DDL, DML, row locks, ledger writes, reservations, or durable audit rows.
- The preflight applies only to `REVENUE` and `CUSTOMER_CREDIT`; A/R continues to reserve the full invoice before provider initiation.
- PawaPay signed requests, the signed-requests-only startup gate, provider identity snapshots, authoritative polling, evidence matching, and ITC's atomic posting path remain required.
- Validation must not apply or adopt a migration, contact a payment provider, or create a payment.
- ITC owns its database and finance APIs; Expense Warrior must not add direct ITC database access.
- Verified provider success without an ITC ledger post remains `VERIFIED_PENDING_LEDGER` and produces no receipt.

## Branch and Checkout Boundaries

- Expense Warrior API checkout: `/home/taosam/front + back/expense-warrior/back`, branch `codex/itc-migration-ledger-clarification`, baseline `4b4afc1`.
- ITC finance module checkout: `/home/taosam/front + back/expense-warrior/.worktrees/itcstore-backend`, branch `codex/expense-warrior-itc-integration`, baseline `26af19f`.
- The ITC migration-adoption primary checkout is a separate branch. At plan time the two ITC branches contain 13 and 19 unique commits respectively; this implementation plan targets the existing integration worktree and does not merge, rebase, or push either branch.

## Review Focus

- **Disabled or malformed ITC target:** reject before readiness queries and make no provider request; Task 1 and Task 2 tests cover it.
- **Provider account changed or not READY:** reject on exact provider ID, code, treasury mapping, accept-new-payments flag, readiness status, or version mismatch; Task 1 tests cover each predicate.
- **ITC timeout before provider submission:** record a terminal local failure because no provider call occurred; do not mislabel it as an unknown provider outcome; Task 4 tests cover it.
- **Same-key replay:** return the stored attempt without repeating a preflight or deposit after an attempt is prepared; Task 4 tests cover it.
- **Readiness race after success:** keep the verified provider evidence pending, do not issue a receipt, and retry the same ITC posting identity; Task 4 tests cover it.

---

### Task 1: Implement read-only ITC readiness service

**Repository:** ITC finance module worktree listed above.

**Files:**
- Modify: `src/services/expenseWarriorFinanceService.js`
- Test: `tests/expenseWarriorFinanceService.test.js`

**Interfaces:**
- Consumes: existing service `config`, `pool`, `resolveMapping`, `isSupportedTreasuryAccount`, and provider account validation rules.
- Produces: `service.preflightCollection(input) -> Promise<{ ready: true }>`; rejects invalid or unready requests with `ExpenseWarriorFinanceError` stable codes.
- Add `validateCollectionPreflight(input) -> normalized input` with an exact allowlist and only `REVENUE` / `CUSTOMER_CREDIT` targets.

- [ ] **Step 1: Write failing service tests** for valid revenue readiness; valid customer-credit readiness; disabled finance; invalid/missing admin actor; unresolved treasury map; inactive/non-postable treasury; provider account ID/code/treasury/version mismatch; `accept_new_payments !== true`; `readiness_status !== 'READY'`; invalid revenue account; unavailable account 2020; invalid customer; and rejected A/R target.
- [ ] **Step 2: Add transaction tests** asserting `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, catalog/data reads only, no `FOR UPDATE`/`FOR SHARE`, and `ROLLBACK` on both ready and blocked paths.
- [ ] **Step 3: Run** `node --test tests/expenseWarriorFinanceService.test.js`; confirm the new preflight cases fail because the interface is missing.
- [ ] **Step 4: Implement** `validateCollectionPreflight` and `preflightCollection` with the exact predicates in the spec. Reuse `resolveMapping` and `isSupportedTreasuryAccount`; query provider-account readiness without `verifyProviderAccountSelection`, because that helper takes a `FOR SHARE` row lock and cannot run in the required read-only transaction. Do not reuse `postCollection` because it performs ledger writes.
- [ ] **Step 5: Re-run** `node --test tests/expenseWarriorFinanceService.test.js`; expect all tests to pass.
- [ ] **Step 6: Commit** the service and tests in the ITC integration worktree.

### Task 2: Expose the signed ITC endpoint

**Repository:** ITC finance module worktree listed above.

**Files:**
- Modify: `src/routes/expenseWarriorFinanceRoutes.js`
- Test: `tests/expenseWarriorFinanceRoutes.test.js`

**Interfaces:**
- Consumes: `service.preflightCollection(input)` from Task 1 and the router's existing `authenticate` middleware.
- Produces: `POST /collections/preflight` under `/api/v1/internal/expense-warrior`, returning `{ success: true, data: { ready: true } }`.

- [ ] **Step 1: Add failing route tests** for successful revenue/customer-credit targets, malformed UUID/version/provider fields, unknown body keys, unsupported targets including A/R, missing service method, stable safe error envelopes, and authenticated middleware enforcement.
- [ ] **Step 2: Run** `node --test tests/expenseWarriorFinanceRoutes.test.js`; confirm the new route tests fail before implementation.
- [ ] **Step 3: Add a Joi schema** with strict unknown-field rejection, exact target-specific fields, provider/account identity, actor, payment-link ID, and collection-attempt ID.
- [ ] **Step 4: Add the route** that delegates the normalized request to the service and uses the existing `sendFailure` behavior. Do not add a public route or change the HMAC middleware contract.
- [ ] **Step 5: Re-run** `node --test tests/expenseWarriorFinanceRoutes.test.js`; expect all tests to pass.
- [ ] **Step 6: Commit** the route and tests in the ITC integration worktree.

### Task 3: Add the signed Expense Warrior client method

**Repository:** Expense Warrior API checkout listed above.

**Files:**
- Modify: `src/integrations/itc/ItcFinanceClient.js`
- Test: `tests/ItcFinanceClient.test.js`

**Interfaces:**
- Produces: `preflightCollectionTarget(payload, idempotencyKey, requestId) -> Promise<{ ready: true }>`.
- Uses the existing signed `#request('POST', ...)` path at `/internal/expense-warrior/collections/preflight`.

- [ ] **Step 1: Write failing client tests** proving the exact path/body/idempotency/request ID are HMAC-signed, `ready: true` is accepted, and malformed/missing readiness responses or ITC error envelopes reject with stable `ItcFinanceError` codes.
- [ ] **Step 2: Run** `node --test tests/ItcFinanceClient.test.js`; confirm the method is absent and the new cases fail.
- [ ] **Step 3: Implement** `preflightCollectionTarget` using the existing private signed request helper; return only the validated readiness result.
- [ ] **Step 4: Re-run** `node --test tests/ItcFinanceClient.test.js`; expect all tests to pass.
- [ ] **Step 5: Commit** the client and tests in the Expense Warrior API checkout.

### Task 4: Gate public non-A/R payment attempts

**Repository:** Expense Warrior API checkout listed above.

**Files:**
- Modify: `src/paymentLinks/publicPaymentService.js`
- Test: `tests/publicPaymentService.test.js`

**Interfaces:**
- Consumes: `itcFinanceClient.preflightCollectionTarget(payload, idempotencyKey, requestId)` from Task 3.
- Produces: a pre-provider gate for `REVENUE` and `CUSTOMER_CREDIT` attempts using the persisted attempt's target and provider-account snapshot.

- [ ] **Step 1: Add failing service tests** proving preflight success precedes exactly one deposit; target rejection marks the attempt `FAILED` and calls no deposit; ITC unavailable before provider call is recorded as a known local failure and calls no deposit; same-key replay does not call preflight or deposit again; A/R still reserves before deposit and never calls preflight.
- [ ] **Step 2: Add a recovery regression test** proving a post-success ITC posting failure remains `VERIFIED_PENDING_LEDGER`, cannot issue a receipt, and reuses the same posting identity when refreshed.
- [ ] **Step 3: Run** `node --test tests/publicPaymentService.test.js`; confirm the new preflight behavior fails before implementation.
- [ ] **Step 4: Implement** the preflight between durable attempt creation and `initiateDeposit`. Map any preflight failure to a terminal local `FAILED` attempt because no provider operation was submitted. Preserve the original idempotency key/fingerprint and do not introduce an automatic retry.
- [ ] **Step 5: Re-run** `node --test tests/publicPaymentService.test.js`; expect all tests to pass.
- [ ] **Step 6: Commit** the provider gate and tests in the Expense Warrior API checkout.

### Task 5: Document the contract and validate the payer retry state

**Repositories:** ITC finance module worktree and Expense Warrior API checkout.

**Files:**
- Modify: ITC `docs/expense-warrior-integration-guide.md`
- Modify: Expense Warrior `docs/itc-finance-service-contract.md`
- Test: frontend `tests/paymentPolling.test.js` or a focused `PublicPaymentView` source test if state rendering changes.

- [ ] **Step 1: Update both contract documents** with the endpoint, signed request behavior, target checks, A/R exclusion, safe failure behavior, read-only transaction, race limitation, and no-migration requirement. Keep ITC database ownership explicit.
- [ ] **Step 2: Inspect the existing public payment failure UI** to confirm `FAILED` preflight attempts show “Try another payment” and that a new try gets a fresh idempotency key. Add a focused test only if the current test coverage does not prove it.
- [ ] **Step 3: Run ITC focused validation:** `node --test tests/expenseWarriorFinanceService.test.js tests/expenseWarriorFinanceRoutes.test.js tests/expenseWarriorServiceProtocol.test.js`; expect all pass.
- [ ] **Step 4: Run Expense Warrior focused validation:** `node --test tests/ItcFinanceClient.test.js tests/publicPaymentService.test.js`; expect all pass.
- [ ] **Step 5: Run complete Expense Warrior API suite** with `npm test`, complete frontend suite/build with `npm test` and `npm run build`, and run ITC's ordinary test suite. Report gated skips separately.
- [ ] **Step 6: Run `git diff --check` in both repositories** and verify the tests made no provider requests, migrations, adoption writes, or finance writes.
- [ ] **Step 7: Commit** the documentation updates in their respective repositories.

### Task 6: Review and handoff

- [ ] **Step 1: Review the full cross-repo diff** for HMAC coverage, strict input validation, provider-call ordering, request identity stability, target/version drift, and A/R behavior.
- [ ] **Step 2: Record validation evidence** in the Expense Warrior and ITC handoff docs, including exact branches/commits, test results, skipped gates, and the remaining account-level PawaPay signed-requests-only verification.
- [ ] **Step 3: Confirm both working trees contain only intended committed changes.** Do not merge, rebase, push, apply/adopt migrations, enable finance/provider flags, or initiate payment operations as part of this plan.
