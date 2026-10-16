# ITC migration 134–135 verification

**Date:** 2026-10-15
**Targets requested:** `itc`, `local_staging`
**Purpose:** verify the reported Expense Warrior finance schema without changing database state.

## Method

Used the backend's `scripts/codex_db.js` with the configured read-only `shopit_accounting_audit` role. The helper asserted the selected database and role, accepted only a single `SELECT`/read-only `WITH`, ran it in a read-only transaction, and capped returned rows. No credentials or secret values were printed.

## Results

| Database | Expected migration objects | Migration ledger/checksum | COA check |
|---|---|---|---|
| `itc` | An earlier catalog check found `commerce_schema_migrations` and all five expected Expense Warrior tables. A fresh check in this continuation could not access `public`, so the earlier object observation was not independently reconfirmed. | The configured audit role is denied access to schema `public`, including the migration-ledger query, so migration names, checksums, and `APPLIED` state could not be checked. | Not checked in this continuation; the same schema permission boundary applies. |
| `local_staging` | A fresh catalog query confirms `commerce_schema_migrations` and all five expected Expense Warrior tables: `expense_warrior_finance_operations`, `expense_warrior_fund_holds`, `expense_warrior_service_nonces`, `expense_warrior_collection_operations`, and `expense_warrior_customer_credit_entries`. | A fresh query for the exact filenames `134_expense_warrior_treasury_holds.sql` and `135_expense_warrior_collections.sql` returned no rows. The migration ledger therefore does not provide application/checksum evidence for these files. | Earlier read-only check found account 2020 as `Customer Credit Payable`, `LIABILITY`, active and postable; account 1020 active/postable; account 1100 `Trade Receivables` inactive and non-postable. These COA observations were not refreshed in this continuation. |

An earlier check of the `itcstore_api` runtime role through PostgreSQL privilege catalogs in both databases found `USAGE` on `public`; `SELECT` and `INSERT` on the finance operations, fund holds, collection operations, and customer-credit entry tables; column-level `UPDATE` only for hold `state` and `resolved_at`; and `EXECUTE` on the nonce-claim and treasury-ledger functions. It had no direct privilege on the service-nonce table. This matched the grants declared by the migration sources, but was not refreshed in this continuation and does not establish which migration file produced them.

The source manifest currently pins these migration checksums:

- `134_expense_warrior_treasury_holds.sql`: `7fca968c587ad8524ce12e261dd16725ad28f2d96ba2a2b4d44f6d4225622a2a`
- `135_expense_warrior_collections.sql`: `2759465bcbaf5246fdd8f4408eabb59d23b5d91a572eeee4f0f00ad9d8be003e`

The fresh catalog result confirms that the expected schema objects exist in `local_staging`. Earlier catalog evidence reported the same for `itc`, but that result was not rechecked because the configured reader now fails on `public` access. These object observations do **not** prove that the exact source files above were applied and recorded with matching checksums. In `local_staging`, the relevant migration ledger rows are absent. In `itc`, the configured reader cannot inspect the ledger. This is consistent with the owner's report that the migrations were applied, but not sufficient to verify the guarded release record.

## Operational boundary

No migrations, database writes, payment-provider calls, or financial postings were performed for this check. Keep finance operations gated until a least-privilege audit reader can verify the two migration ledger entries and checksums in both targets, then complete the existing account/provider and transaction-readiness review. The inactive/non-postable 1100 account is a separate prerequisite for the approved A/R feature; migrations 134–135 do not establish that A/R workflow.

## Read-only recheck

During the 15 October continuation, the same least-privilege helper was rerun from the primary `itcstore-backend` checkout because the isolated integration worktree does not contain the audit-reader connection variables. The helper asserted the `shopit_accounting_audit` identity and ran each query in a read-only transaction. The recheck again returned no rows for migration 134 or 135 in `local_staging`; the `itc` query again failed with `permission denied for schema public`. No credentials were printed and no write-capable database identity was used.

The `local_staging` chart-of-accounts check was refreshed: account 1020 (`PawaPay Clearing – ZMW`) is an active, postable asset; account 1100 (`Trade Receivables`) is an inactive, non-postable asset; and account 2020 (`Customer Credit Payable`) is an active, postable liability. This leaves A/R collection explicitly blocked by the 1100 account state. The 1020 and 2020 states do not prove that the migration ledger entries exist or authorize collection posting.

## Read-only runtime-role catalog check

In a later continuation, a read-only PostgreSQL transaction using the configured `itcstore_api` database identity checked only catalog visibility and migration metadata. All five expected tables were present in both `itc` and `local_staging`: `expense_warrior_finance_operations`, `expense_warrior_fund_holds`, `expense_warrior_service_nonces`, `expense_warrior_collection_operations`, and `expense_warrior_customer_credit_entries`. In `itc`, the exact 134/135 filenames returned no rows from `commerce_schema_migrations`. In `local_staging`, the same identity was denied `SELECT` on that ledger; the earlier read-only audit-reader check returned no matching rows there. No DML or migration command was executed.

This reconfirms the schema objects but does not verify that the guarded release ledger contains either migration with its source checksum. Keep finance calls disabled until a least-privilege audit identity can verify the exact ledger entries in both databases and the separate account/provider readiness checks pass. The API role result is supplemental schema evidence, not a substitute for the audit-reader release check.

## Read-only recheck — 16 October 2026

Using `scripts/codex_db.js` again with the asserted `shopit_accounting_audit` read-only login:

- Both `itc` and `local_staging` expose the migration ledger and all five expected Expense Warrior finance tables in `public` through PostgreSQL catalog inspection.
- In `local_staging`, selecting the exact migration 134/135 ledger rows succeeds but returns no rows. Therefore the expected tables exist, but the guarded migration ledger does not record these source migration filenames there.
- In `itc`, the audit login receives `permission denied for schema public` when selecting the ledger. A separate catalog-only query can see the ledger and expected tables, but cannot verify their recorded checksums or applied state.
- The checked-out migration source SHA-256 values still match the release manifest: `134_expense_warrior_treasury_holds.sql` is `7fca968c587ad8524ce12e261dd16725ad28f2d96ba2a2b4d44f6d4225622a2a`; `135_expense_warrior_collections.sql` is `2759465bcbaf5246fdd8f4408eabb59d23b5d91a572eeee4f0f00ad9d8be003e`.
- The current `local_staging` COA still has 1020 (`PawaPay Clearing – ZMW`) active/postable and 2020 (`Customer Credit Payable`) active/postable. Account 1100 (`Trade Receivables`) remains inactive/non-postable, so A/R collection is not ready even apart from migrations 136–137.

No DDL/DML, migrations, provider calls, or financial postings were performed. The next verification prerequisite is a least-privilege reader that can inspect `commerce_schema_migrations` in both targets. Until then, do not infer successful application from table presence or the owner's migration report, and keep the finance feature gates off.

## Read-only schema-shape comparison — 16 October 2026

Using the same guarded audit role, read-only catalog queries compared the live `itc` and `local_staging` schema with the checked-out 134/135 migration sources:

- All five expected tables have the source column names, order, PostgreSQL types, and nullability in both databases.
- The expected primary/unique/check/foreign-key constraints and all 18 Expense Warrior indexes are present in both databases.
- All eight migration-defined Expense Warrior triggers and the expected nonce, hold-transition, treasury-ledger, customer-credit, and immutable-event functions are present. Catalog flags show `apply_treasury_ledger_entry` and `claim_expense_warrior_service_nonce` are `SECURITY DEFINER`; guard functions are invoker functions.
- The release-ledger result is unchanged: `local_staging` has a 133 entry but no 134/135 entries. In `itc`, the audit role cannot access `public` to read ledger rows.

This verifies a close match in the inspected live schema shape. It does not prove that the guarded migration runner applied the exact source files, that function bodies match byte-for-byte, or that the migration ledger contains matching 134/135 checksums. Do not treat this catalog comparison as permission to enable finance operations or as a substitute for ledger access. No business rows were read, and no database or provider writes were performed.
