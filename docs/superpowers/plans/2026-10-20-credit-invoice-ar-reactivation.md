# Credit invoice A/R reactivation implementation plan

> **For agentic workers:** Execute this approved scope task by task with TDD. Keep every database change source-only until separately authorized.

**Goal:** Complete the previously owner-approved V1 flow for delivered credit invoices: full-balance A/R payment links, atomic ITC reservation and posting, and credit-note/refund handling.

**Architecture:** ITC remains authoritative for credit orders, receivables, reservations, journals, and returns. Expense Warrior stores only link/attempt references and invokes ITC's signed API; PawaPay success is polled and matched before ITC posts. Re-enable the source contract after migration 143 through a new additive migration, without rewriting applied migrations.

**Tech Stack:** Node.js, Express, PostgreSQL, `node:test`, Vue 3/Vite, signed ITC HMAC APIs, PawaPay provider adapter.

**Spec:** `../specs/2026-10-15-credit-invoices-ar-payment-links-design.md`; return/refund detail in `../specs/2026-10-15-itc-expense-warrior-collection-refunds-design.md`.

## Global constraints

- Full outstanding ZMW balance only; only fully delivered credit invoices can be linked.
- One active reservation per receivable across all links; unknown outcomes retain it for reconciliation.
- Provider success is not financial success until authoritative PawaPay evidence matches and ITC confirms the atomic posting.
- Keep ITC database access inside ITC; Expense Warrior uses signed APIs and never maintains authoritative A/R balances.
- Credit notes and collection refunds are mutually exclusive for the same returned value and remain idempotent.
- Add migrations after 144; do not edit or replay migrations 136–144.
- Do not apply or adopt migrations, enable finance flags, dispatch credit goods, call PawaPay, or post financial transactions during implementation.
- Preserve the existing approved branches: Expense Warrior backend's current checkout, frontend `main`, and ITC `production`; do not create or switch branches.

## Review focus

- Concurrent links for one invoice: at most one active full-balance reservation.
- Stale fixed link or already-settled receivable: reject before PawaPay submission.
- Timeout after provider submission: retain the same attempt/reservation identity and do not issue a receipt.
- Customer, invoice, amount, provider identity, or idempotency mismatch: fail closed without posting.
- Return/payment race: serialize on the ITC receivable and never create both a credit note and cash refund for the same value.

## Tasks

1. **ITC schema and release artifacts:** Add migration 145 to restore the collection receivable reference and `AR_SETTLEMENT` constraints after 143, validate account 1100's exact identity before enabling posting, register its checksum and explicit release gate, and add source plus disposable-PostgreSQL migration tests.
2. **ITC receivable service contract:** Implement signed list/read/validate, reserve/release/status, collection preflight, and atomic A/R collection posting using migrations 136–139 tables. Add route validation/auth tests and disposable-PostgreSQL transaction/concurrency tests.
3. **Expense Warrior API:** Restore the ITC client methods, invoice-backed link creation, exclusive reservation before provider initiation, definitive-failure release, verified-post retry/recovery, link closure, and masked admin reporting. Add repository/service/route tests and source-only local migration changes if required.
4. **Expense Warrior frontend:** Restore admin invoice selection/link creation and safe payer status/receipt behavior. Keep revenue/customer-credit options intact. Add component/state tests and browser-check mocked flows at 390px and 320px.
5. **ITC returns and backoffice:** Complete unpaid credit-note and collected-credit refund states/controls, hide ordinary cash refunds for credited returns, and test replay/concurrency with the existing ITC return/refund paths.
6. **Cross-repo verification and release evidence:** Run focused and full suites, disposable PostgreSQL and mocked mobile browser flows, review all migrations/feature gates/contracts, and update release docs with exact validation evidence. Keep database/provider release gates visible and unapplied.
