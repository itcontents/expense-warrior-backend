# Credit invoice A/R reactivation implementation plan

> **For agentic workers:** Execute this approved scope task by task with TDD. Keep every database change source-only until separately authorized.

**Goal:** Complete the previously owner-approved V1 flow for delivered credit invoices: full-balance A/R payment links, atomic ITC reservation and posting, and credit-note/refund handling.

**Architecture:** ITC remains authoritative for credit orders, receivables, reservations, journals, and returns. Expense Warrior stores only link/attempt references and invokes ITC's signed API; PawaPay success is polled and matched before ITC posts. Re-enable the source contract after migration 143 through a new additive migration, without rewriting applied migrations.

**Tech Stack:** Node.js, Express, PostgreSQL, `node:test`, Vue 3/Vite, signed ITC HMAC APIs, PawaPay provider adapter.

**Spec:** `../specs/2026-10-15-credit-invoices-ar-payment-links-design.md`; return/refund detail in `../specs/2026-10-15-itc-expense-warrior-collection-refunds-design.md`.

## Current implementation and release status — 2026-10-22

This approved plan has been implemented in source on the existing branches. Do not execute the original task list as new implementation work: in particular, do not create a second migration 145 or use the original single-migration sequence. The current source of truth for ITC A/R migrations is `itcstore-backend/scripts/expense-warrior-ar-release-manifest.json`; it lists 148, 149, 137, 138, 145, 147, and 146 in order. Migrations 136 and 139 were replaced by forward artifacts. The ITC release remains separate from the default Shop.IT commerce release.

Implementation commits are ITC `a933998`, Expense Warrior API `2dec5b2`, Expense Warrior frontend `3aba8af`, and Backoffice credit-quote entry point `0404c08`, all on the existing approved branches. Recorded source verification on 2026-10-22: Expense Warrior API `npm test` passed 397 with 4 database-gated skips and `npm run test:postgres` passed 4/4 using temporary tables; frontend tests passed 69/69; ITC commerce safety passed 321 with 9 gated skips, credit-note tests 16/16, and focused credit-invoice/A/R/return tests 50/50; Backoffice credit-quote tests passed 5/5 and its production build passed. These checks do not prove authenticated cross-service finance behavior or provider settlement.

Release is **not ready**. Fresh read-only staging checks show only migration 144 among ITC migrations 134–149 and confirm the required Expense Warrior finance/A/R tables are absent. Local Expense Warrior and ITC finance flags remain off; the signed ITC service credentials/key map, Treasury binding, and PawaPay ITC account ID/version are unset. PawaPay merchant-level signed-only enforcement is unverified. The local APIs answer health/readiness checks, but there is no authenticated Expense Warrior session and no signed finance readiness proof. No ITC staging/production migration, PawaPay transaction, or accounting posting was performed during this verification.

The remaining work is owner-controlled release readiness, not another implementation pass: run ITC's target-specific read-only migration preflight; resolve migration provenance and apply only the reviewed artifacts through the ITC release path after exact owner authorization; configure and verify the signed service/Treasury/provider-account bindings and merchant signed-only setting; then run authenticated read-only API tests followed by explicitly authorized end-to-end financial tests. Keep all financial flags disabled until those checks pass. Detailed current evidence and command results are in the [shared handoff](../../../../docs/itc-expense-warrior-shared-handoff.md).

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

## Original implementation tasks and current status

1. **ITC schema and release artifacts — source complete.** Current sequence and checksums are pinned in the separate A/R release manifest; use its read-only preflight and owner-controlled apply/adopt operations.
2. **ITC receivable service contract — source complete.** Signed list/read, reservation/release, and atomic posting paths are implemented behind default-off gates. Disposable PostgreSQL rollback/concurrency evidence for the ITC transaction path remains outstanding.
3. **Expense Warrior API — source complete.** Invoice-backed links, ITC reservation/recovery, immutable provider identity snapshots, closure, and masked reporting are implemented; local API and repository tests pass as recorded above.
4. **Expense Warrior frontend — source complete.** Invoice-backed link setup and payer states are implemented. Fixture previews are verified at mobile sizes; authenticated API/browser flows remain unverified.
5. **ITC returns and backoffice — source partial.** ITC credit-note/refund logic and the Backoffice unpaid credit-invoice conversion entry point are implemented. Confirm and complete any remaining admin return/refund controls during the authenticated cross-repo review; do not treat the quote-conversion UI test as proof of the return workflow.
6. **Cross-repo verification and release evidence — incomplete.** Local automated and fixture checks pass, but staging schema/configuration, authenticated API behavior, end-to-end provider status/posting/refund recovery, and production deployment remain unverified. Keep the gates described above closed.
