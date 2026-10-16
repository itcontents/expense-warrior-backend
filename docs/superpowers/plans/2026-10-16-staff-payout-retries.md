# Staff Payout Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin retry a terminally failed staff payout on the same request after ITC confirms the old hold was released, while preserving every payout attempt and hold identity.

**Architecture:** Add per-attempt reservation identity and hold snapshots, replace the one-attempt-per-request constraint with a one-active-attempt partial unique index, and add an explicit retry/resume service route. The admin recovery UI will show retry only for a released terminal failure and will use the existing audited destination reveal and confirmation flow.

**Tech Stack:** Node.js 20+, Express 5, PostgreSQL, `node:test`, Vue 3, Vite, Playwright browser validation.

**Spec:** `docs/superpowers/specs/2026-10-16-staff-payout-retry-design.md`

## Global Constraints

- A retry is allowed only after PawaPay confirms terminal failure and ITC confirms that the original hold was released.
- Every retry creates a new immutable payout attempt and provider transaction identity and obtains a new ITC reservation before provider submission.
- Pending, unknown, verification-required, and unreleased attempts remain locked for reconciliation; they never start a replacement payout.
- Unknown ITC reservation results resume the same attempt and reservation operation; no PawaPay call occurs until ITC confirms a matching active hold.
- ITC remains the authority for identity, holds, treasury balances, and ledger posting; Expense Warrior uses its signed API and never connects to the ITC database.
- Retry is admin-only, self-review remains prohibited, and retries do not create duplicate approval decisions.
- Preserve provider/account, network, amount, currency, destination binding, and expense-category snapshots for each attempt.
- Author migration `0015_staff_payout_retries.sql`; do not apply migrations, create ITC holds, or contact PawaPay during implementation or validation.
- Financial transitions remain transactional, idempotent, and auditable; provider free-text errors must not be exposed.

## Review Focus

- **Unknown ITC reservation:** the same attempt and operation must be resumed, with no provider call before a matching active hold. Pin in the retry service tests.
- **Concurrent retry requests:** only one active attempt may exist and duplicate requests must not create distinct ITC operations or provider submissions. Pin the partial unique index in migration/PostgreSQL tests and exercise concurrent service entry; do not claim cross-connection proof unless the test harness uses a dedicated disposable database.
- **Payout terminality and hold release:** `PENDING`, `UNKNOWN`, `VERIFICATION_REQUIRED`, `FAILED_PENDING_RELEASE`, missing release, and `PAID` must not create a new attempt. Pin in repository and service tests.
- **Provider account changes:** retry must use the saved provider/account version and network from the approved attempt, or fail closed if that exact account is unavailable. Pin in the service test with a changed current account selection.
- **Multiple attempts in request lists:** request and recovery views must select only the latest attempt and must not duplicate a request. Pin in repository and temporary-PostgreSQL tests.

---

### Task 1: Add the append-only payout-attempt schema

**Files:**
- Create: `src/db/migrations/0015_staff_payout_retries.sql`
- Create: `tests/staffPayoutRetryMigration.test.js`
- Modify: `tests/helpers/postgresTestSchema.js`
- Modify: `tests/approvalPayoutRepository.postgres.test.js`

**Interfaces:**
- Produces: `request_payout_attempts` permits multiple terminal attempts for one request, stores each attempt's reservation operation/idempotency/hold/state, and enforces no more than one active attempt per request.
- Existing rows: backfill their reservation snapshot from the matching `expense_requests` row; retain existing provider, account, amount, currency, network, and client-reference values.

- [ ] **Step 1: Write migration guard tests** in `tests/staffPayoutRetryMigration.test.js` for the 0015 filename/order, removal of `request_id` uniqueness, reservation snapshot columns/backfill, the partial active-attempt index, and the added `RESERVING`/`RESERVATION_FAILED` state constraints.
- [ ] **Step 2: Run `node --test tests/staffPayoutRetryMigration.test.js` and confirm it fails** because migration 0015 and its invariants are absent.
- [ ] **Step 3: Implement migration 0015.** Drop only the existing generated unique constraint on `request_id`; add reservation snapshot fields and checks; backfill prior rows; extend the state check; create the partial unique active-attempt index and latest-attempt lookup index. Do not edit an applied migration.
- [ ] **Step 4: Update the temporary PostgreSQL test schema helper** to drop the copied request-id unique constraint, then add migration 0015 columns, constraints, and the partial active-attempt index to session-local test tables without applying the migration.
- [ ] **Step 5: Run `node --test tests/staffPayoutRetryMigration.test.js` and confirm it passes.**
- [ ] **Step 6: Run `EW_RUN_POSTGRES_TESTS=1 node --test tests/approvalPayoutRepository.postgres.test.js`** and confirm initial payout preparation still works with the source-only columns.
- [ ] **Step 7: Commit** the migration, guard, temporary-schema helper, and targeted PostgreSQL compatibility test.

### Task 2: Preserve per-attempt holds and return only the latest payout

**Files:**
- Modify: `src/payouts/staffPayoutRepository.js`
- Modify: `src/requests/requestRepository.js`
- Create: `tests/staffPayoutRepository.test.js`
- Modify: `tests/requestRepository.test.js`
- Modify: `tests/approvalPayoutRepository.postgres.test.js`

**Interfaces:**
- `loadPayout(client, requestId, { lock })` returns the latest attempt ordered by `created_at DESC, payout_id DESC`.
- `preparePayoutRetry({ pool, actor, requestId, requestIdForAudit, idFactory })` returns the existing reserving attempt for safe replay or creates one new attempt only after a failed/released attempt; it returns a stable reservation operation and idempotency key.
- `completeRetryReservation({ pool, actor, requestId, payoutId, reservation, financeOperation, requestIdForAudit })` records a verified new hold on that attempt and the current request; it returns `shouldInitiate: true` only to the transaction that atomically advances `RESERVING` to `SUBMITTING`.
- `markRetryReservationFailure({ pool, actor, requestId, payoutId, operationId, state, errorCode, requestIdForAudit })` records definitive failure or unknown reservation state without losing the prior attempt.

- [ ] **Step 1: Write failing repository tests** for retry eligibility, stable replay of a `RESERVING` attempt, fresh attempt/operation identities after confirmed release, preservation of the old hold snapshot, and latest-attempt selection in request/recovery queries.
- [ ] **Step 2: Run `node --test tests/staffPayoutRepository.test.js tests/requestRepository.test.js` and confirm the new assertions fail** on missing repository operations or one-row query assumptions.
- [ ] **Step 3: Snapshot the first attempt's reservation** when `prepareFinalApproval` creates it; update completion and release methods to compare and use the selected attempt's hold snapshot rather than relying on the mutable request-level hold.
- [ ] **Step 4: Implement `preparePayoutRetry`, `completeRetryReservation`, and `markRetryReservationFailure`.** Lock the request and latest attempt, require `PAYOUT_FAILED` plus a terminal failed attempt with `release_state = RELEASED`, reuse an existing `RESERVING` attempt, and persist a fresh stable reservation and payout identity before remote calls.
- [ ] **Step 5: Change request projections to join only the latest payout attempt** so additional history rows do not duplicate request rows; return the latest attempt's status and failure code.
- [ ] **Step 6: Update `listRecovery`** to return the latest attempt per request when it is unresolved or retry-eligible, including `RESERVING` and `RESERVATION_FAILED` only when the preceding provider failure's hold is confirmed released; include a server-derived `retry_allowed` boolean for UI display only.
- [ ] **Step 7: Run the focused repository tests and `EW_RUN_POSTGRES_TESTS=1 node --test tests/approvalPayoutRepository.postgres.test.js tests/requestRepository.postgres.test.js`.** Confirm old payout replay remains idempotent, a second active attempt violates the partial unique index, and request lists remain one row per request.
- [ ] **Step 8: Commit** the repository, query, and focused test changes.

### Task 3: Add the admin retry and reservation-resume API

**Files:**
- Modify: `src/payouts/staffPayoutService.js`
- Modify: `src/payouts/staffPayoutRoutes.js`
- Modify: `src/app.js`
- Modify: `tests/staffPayoutService.test.js`
- Create: `tests/staffPayoutRoutes.test.js`

**Interfaces:**
- Service: `retry(actor, requestId, requestIdForAudit = null)`; admin-only, returns the existing `{ request, pending, errorCode? }` result shape.
- Route: `POST /api/v1/expense-warrior/admin/requests/:request_id/payout/retry`; returns HTTP 202 while reservation/provider outcome is pending and HTTP 200 for a confirmed terminal result. It accepts no caller-controlled provider, account, destination, amount, hold, or operation fields.
- Existing `reconcile` remains the only action for provider attempts already submitted or with ambiguous outcomes.

- [ ] **Step 1: Write failing service tests** for admin-only access, exact terminal failure/release eligibility, new provider ID, saved account-version selection, ITC reserve before provider initiation, attempt-specific hold consumption/release, unchanged approval decisions, and rejection of unresolved/paid/unreleased cases.
- [ ] **Step 2: Write failing route tests** in `tests/staffPayoutRoutes.test.js` proving the retry route requires a session, rejects malformed request IDs before service access, forwards an authenticated admin actor to `retry`, and propagates pending/confirmed HTTP status codes.
- [ ] **Step 3: Add failing reservation recovery and concurrency tests** proving an unknown ITC response keeps the same attempt/operation, retry reuses the same idempotency key, duplicate concurrent calls create one provider submission, and provider initiation waits for a matching active hold.
- [ ] **Step 4: Run `node --test tests/staffPayoutService.test.js tests/staffPayoutRoutes.test.js` and confirm the new retry tests fail** because the service method and route do not exist.
- [ ] **Step 5: Implement `retry`** using the repository interfaces from Task 2. Validate the signed ITC reservation response against request, operation, amount, currency, provider/account version, expense category/account, and active hold before submitting one new provider transaction. Record definite reservation failures without contacting the provider; preserve unknown attempts for exact replay.
- [ ] **Step 6: Add the retry route and dependency validation** in `staffPayoutRoutes.js` and `app.js`; keep `final-approve`, reconciliation, and bulk approval behavior separate.
- [ ] **Step 7: Run `node --test tests/staffPayoutService.test.js tests/staffPayoutRoutes.test.js` and the backend `npm test`.** Confirm existing final-approval, reconciliation, and bulk paths remain green.
- [ ] **Step 8: Commit** the API/service changes and tests.

### Task 4: Expose safe retry and resume actions in the admin UI

**Files:**
- Modify: `../front/src/api/expenseWarrior.js`
- Modify: `../front/src/views/WorkspaceView.vue`
- Create: `../front/src/payouts/payoutRecoveryAction.js`
- Create: `../front/tests/payoutRetryApi.test.js`
- Create: `../front/tests/payoutRecoveryAction.test.js`

**Interfaces:**
- API client: `retryRequestPayout(requestId)` posts to the new retry route and returns the standard data envelope.
- Recovery item: latest payout state, server-derived `retry_allowed`, provider/network label, and error code determine the available action; the browser never supplies financial identities.
- `getPayoutRecoveryAction(item, role)` returns `retry`, `resume`, `reconcile`, or `null`; only admins receive actions, and retry depends on `item.retry_allowed === true`.

- [ ] **Step 1: Write a failing API client test** asserting `retryRequestPayout` sends an authenticated POST to the exact request retry route and unwraps `{ data }`.
- [ ] **Step 2: Run `node --test tests/payoutRetryApi.test.js` in `front/` and confirm it fails** because the API function does not exist.
- [ ] **Step 3: Implement `retryRequestPayout`** using the existing `expenseWarriorRequest` wrapper.
- [ ] **Step 4: Write failing `payoutRecoveryAction.test.js` cases** for an admin's eligible terminal retry, reservation resume, unresolved reconciliation, ineligible terminal state, and non-admin role; run it and confirm the helper is absent.
- [ ] **Step 5: Implement `getPayoutRecoveryAction(item, role)`** in `src/payouts/payoutRecoveryAction.js` and run the helper tests to green.
- [ ] **Step 6: Implement the admin recovery UI** in `WorkspaceView.vue`. Reuse the audited payout-destination reveal and confirmation dialog; show amount, network, and revealed destination before a retry; disable repeated clicks while the operation is in flight; refresh recovery state after completion.
- [ ] **Step 7: Run the frontend test suite and build.** Exercise retry, reservation resume, and reconciliation in a mocked browser at 390px and 320px; confirm no horizontal overflow, console errors, or real ITC/PawaPay calls.
- [ ] **Step 8: Commit** frontend API, UI, and tests.

### Task 5: Cross-layer financial review and release-boundary verification

**Files:**
- Modify: `PLAN.md`
- Modify: `README.md`
- Modify: `../.worktrees/itcstore-backend/docs/expense-warrior-integration-guide.md` only if the implemented endpoint/state contract differs from its committed retry-boundary note.

**Interfaces:**
- No new public API. This task reconciles documentation with the implemented state transitions and reports validation evidence without claiming live financial readiness.

- [ ] **Step 1: Review every retry transition** against the design spec: terminal provider failure, confirmed old hold release, new persisted reservation operation, confirmed new hold, one new provider ID, and attempt-specific consume/release.
- [ ] **Step 2: Run the complete Expense Warrior backend suite** with `npm test`; require all non-PostgreSQL tests to pass.
- [ ] **Step 3: Run the gated PostgreSQL suite** with `npm run test:postgres`; require all configured temporary-table tests to pass without applying migration 0015 or writing persistent application rows.
- [ ] **Step 4: Run the frontend suite and production build** with `npm test && npm run build` in `front/`.
- [ ] **Step 5: Run the mocked mobile browser flow** for eligible retry, unknown reservation resume, locked unresolved payout, and confirmed result. Verify 390px and 320px widths and inspect console/network requests.
- [ ] **Step 6: Run `git diff --check` and review migration 0015** to confirm it is additive, sequence-correct, and not applied; verify payout feature gates remain off and no provider or ITC financial operations ran.
- [ ] **Step 7: Update the release status docs** with the new source migration and exact validation limits, then commit the documentation.

## Execution Notes

- The current PostgreSQL harness uses session-local temporary tables. It can validate constraints and transaction behavior without applying migration 0015. Do not claim cross-connection race proof from a single-session temporary-table test; if no isolated disposable database is authorized, record that concurrency check as a pre-enable release gate.
- No production or staging migration, ITC hold, PawaPay payout, or payment operation is included in this plan.
