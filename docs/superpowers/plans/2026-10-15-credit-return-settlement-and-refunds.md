# Credit return settlement and collection refunds implementation plan

> **For agentic workers:** Execute the approved return design task by task. Keep database changes source-only until separately authorized.

**Goal:** Complete return accounting for delivered credit invoices: issue an atomic credit note while A/R is open, and use the original PawaPay deposit refund flow after the A/R collection has settled.

**Architecture:** ITC owns return, receivable, inventory, refund, and journal state, including PawaPay refund submission through its existing asynchronous refund worker. Expense Warrior does not run a second refund orchestrator. A return and a collection reservation must serialize on the same ITC receivable row. Only verified terminal provider evidence may trigger refund posting.

**Tech Stack:** Node.js CommonJS, Express, PostgreSQL, existing ITC return models, PawaPay v2 adapter, signed ITC finance APIs, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-15-credit-invoices-ar-payment-links-design.md`.

## Global constraints

- Only explicit `CREDIT` orders with a dispatched receivable can use the credit-return path; prepaid storefront and cash-quote return flows remain unchanged.
- V1 credit invoices are ZMW, TOT, and zero VAT; unknown tax, order, source allocation, or account evidence fails closed.
- Credit notes reduce A/R and reverse approved revenue once; saleable accepted goods restore FIFO inventory and reverse matching COGS in the same transaction.
- An active A/R collection reservation blocks return approval; an active return blocks a new collection reservation. Unknown PawaPay outcomes remain unresolved and cannot be replaced or released by elapsed time.
- PawaPay refunds use a stable `refundId` and the original verified `depositId`; `ACCEPTED` is not success. Signed financial requests are mandatory.
- No database migration, provider call, credit dispatch, refund, or financial posting during implementation or validation.
- Do not commit or push inherited user changes.

## Review focus

- A/P return vs. collected A/R: only the invoice's current receivable state selects credit-note or refund path.
- Return/payment race: lock both operations on the same receivable; no active return and reservation may overlap.
- Partial return arithmetic: cumulative approved quantity and revenue/COGS reversal never exceed source dispatch allocations.
- Replay and ambiguity: one credit note or provider refund per return; unknown provider results retain their state and never cause a second refund.
- Ordinary paid returns: current canonical payment/refund behavior and segregation checks remain unchanged.

## Planned tasks

### Task 1: Return eligibility and receivable serialization

**Files:** `itcstore-backend/src/services/returnEligibilityPolicy.js`, `src/models/returns/ReturnRequestModel.js`, `src/services/expenseWarriorFinanceService.js`, `tests/returnEligibilitySafety.test.js`, and focused return/reservation tests.

- [x] Permit delivered, explicitly marked credit orders only when their receivable has a positive outstanding balance and no active reservation.
- [x] Lock the receivable when a credit-order return is created; reject if a reservation is active.
- [x] Reject ITC A/R reservation when an active return request exists. Use the same receivable row lock as return creation, then check return state in a fresh statement snapshot.
- [x] Add tests for unpaid-credit eligibility, settled-credit rejection, active-reservation rejection, reservation rejection during active return, and unchanged prepaid eligibility.
- [x] Run focused policy and ITC reservation tests.

### Task 2: Atomic credit-note posting for unpaid credit invoices

**Files:** guarded ITC migration 138, `customerCreditNoteService.js`, `ReturnRequestModel.approveReview`, migration/release tests, and credit-note accounting tests.

- [x] Add immutable credit-note header/event identity and a distinct `CREDITED` return status with additive constraints/indexes (source-only migration 138).
- [ ] During admin approval, lock order and receivable, require positive outstanding balance and no active collection reservation, validate the source sale journal and return calculation, restore FIFO stock only for `restock_action='restock'`, then atomically debit revenue/1100 as appropriate and credit inventory/COGS where goods are accepted as saleable. Source code now follows this path; mocked model-transaction tests cover active-reservation rollback, a complete commit path, and write-free replay. Live PostgreSQL transaction and concurrency tests are still needed.
- [x] Make replay idempotent by return-request identity. Replay checks the immutable credit note and journals, then matches each restock line to its FIFO restore allocations and stock transactions. Mocked tests reject missing or mismatched restoration evidence without writing again.
- [ ] Prevent the ordinary refund endpoint from initiating cash/provider refund for a credit-noted return.
- [ ] Run accounting safety, return pricing, inventory cost layer, migration release, and full ITC test suites. Do not apply the migration.

### Task 3: PawaPay refund orchestration for settled A/R collections

**Files:** `itcstore-backend/src/services/returnRefundWorkflowService.js`, `src/services/paymentRefundWorker.js`, `src/services/refundAccountingService.js`, `src/services/refundCompletionService.js`, source-tag migration 139, and focused ITC tests. Expense Warrior remains responsible for the original collection operation and its immutable provider-account snapshot; it does not initiate the later return refund.

- [x] Persist the stable ITC refund request and outbox command with the exact verified collection operation, original deposit ID, approved amount, return ID, and trusted provider account/version.
- [x] Submit once through ITC's existing payment refund worker; preserve accepted/rejected/unknown outcomes and reuse the stable refund identity during recovery.
- [x] Verify authoritative PawaPay refund evidence against the stored refund identity and source before completion.
- [x] Atomically post the refund through ITC's return accounting workflow, update return/order state, and append immutable events; cap refund requests against the verified collection amount.
- [x] Retain unknown outcomes for exact-identity reconciliation; do not create a replacement refund after ambiguity.
- [ ] Run mock contract tests, DB integration/concurrency tests where supported, and full Expense Warrior and ITC suites. Do not call PawaPay or apply migrations.

### Task 4: Backoffice and customer return presentation

**Files:** `itc-store-backoffice` return list/detail and customer return screens as applicable, plus contract tests.

- [ ] Show distinct `CREDITED`, refund-pending, refund-unknown, and refund-completed states with the credit note/refund reference and safe recovery actions.
- [ ] Hide ordinary cash-refund controls for a credit-noted return and avoid presenting a PawaPay acceptance as a completed refund.
- [ ] Verify desktop/mobile UI, authorization, API failures, and ordinary return regressions.

## Current status

ITC source implements tagged A/R collection refunds through the existing return approval, PawaPay worker, status reconciliation, treasury posting, and accounting replay paths. It fails closed if the verified collection/source account cannot be proven, enforces reviewer/operator separation, caps total refunds to the collection, and keeps its feature gate off by default. Credit-return eligibility, return-vs-collection serialization, source-only migrations 138–139, source-journal reconciliation, and the distinct `CREDITED` path have focused tests. The focused cross-source tests passed on 2026-10-16 (17 tests), including ITC source validation, worker submission, release gating, and replay evidence. PostgreSQL transaction/concurrency coverage and an authorized sandbox refund are still required before enablement; neither was run. The ITC backoffice presentation of credit-note and refund-pending/unknown/completed states remains a separate UI task. PawaPay docs: [initiate refund](https://docs.pawapay.io/v2/api-reference/refunds/initiate-refund), [check refund status](https://docs.pawapay.io/v2/api-reference/refunds/check-refund-status).
