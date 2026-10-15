# Credit return settlement and collection refunds implementation plan

> **For agentic workers:** Execute the approved return design task by task. Keep database changes source-only until separately authorized.

**Goal:** Complete return accounting for delivered credit invoices: issue an atomic credit note while A/R is open, and use the original PawaPay deposit refund flow after the A/R collection has settled.

**Architecture:** ITC remains authoritative for return, receivable, inventory, and journal state. Expense Warrior owns PawaPay refund initiation and provider-status reconciliation. A return and a collection reservation must serialize on the same ITC receivable row. Only verified terminal provider evidence may trigger refund posting.

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
- [ ] Make replay idempotent by return-request identity; reject a mismatch or incomplete prior inventory restoration.
- [ ] Prevent the ordinary refund endpoint from initiating cash/provider refund for a credit-noted return.
- [ ] Run accounting safety, return pricing, inventory cost layer, migration release, and full ITC test suites. Do not apply the migration.

### Task 3: PawaPay refund orchestration for settled A/R collections

**Files:** Expense Warrior refund-attempt migration/repository/service/routes and callback inbox; ITC signed refund-command/status and finalization routes/service; related cross-service tests.

- [ ] Persist a stable refund command using the verified collection operation, original deposit ID, amount, return ID, and provider id.
- [ ] Initiate the refund once through `providerRegistry.getForOperation(provider, 'refund')`; store `ACCEPTED`, rejection, or unknown without duplicate submission.
- [ ] Verify authoritative PawaPay refund status and identity/amount/currency before asking ITC to finalize.
- [ ] ITC atomically posts the refund against the collection and return accounting, updates the return/order state, and appends an immutable event; use idempotency and amount caps against the original collection.
- [ ] Keep unknown provider outcomes pending for exact-id recovery; no new refund ID after ambiguity.
- [ ] Run mock contract tests, DB integration/concurrency tests where supported, and full Expense Warrior and ITC suites. Do not call PawaPay or apply migrations.

### Task 4: Backoffice and customer return presentation

**Files:** `itc-store-backoffice` return list/detail and customer return screens as applicable, plus contract tests.

- [ ] Show distinct `CREDITED`, refund-pending, refund-unknown, and refund-completed states with the credit note/refund reference and safe recovery actions.
- [ ] Hide ordinary cash-refund controls for a credit-noted return and avoid presenting a PawaPay acceptance as a completed refund.
- [ ] Verify desktop/mobile UI, authorization, API failures, and ordinary return regressions.

## Current status

PawaPay signed `initiateRefund` and `getRefundStatus` adapter methods and provider capability checks are implemented and covered by mocked tests. Credit-return eligibility, return-vs-collection serialization, source-only migration 138, source-journal reconciliation, and a distinct credit-note approval path are implemented and covered by focused policy, schema, mocked-posting, source-journal, notification, guard, and model-transaction tests. PostgreSQL transaction and concurrency coverage is still needed before this return approval change is ready to enable; no credit-note posting was run against a database and no migration or financial posting was performed. The broad commerce safety suite needs configured ITC test database identity. Settled-collection refund orchestration and UI states remain incomplete. PawaPay docs: [initiate refund](https://docs.pawapay.io/v2/api-reference/refunds/initiate-refund), [check refund status](https://docs.pawapay.io/v2/api-reference/refunds/check-refund-status).
