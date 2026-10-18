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

## Read-only release-gate recheck — 18 October 2026

Using `scripts/codex_db.js` from the primary `itcstore-backend` checkout, each query ran in a read-only transaction after the helper asserted the `shopit_accounting_audit` login. No credentials were printed.

- In `local_staging`, `public.commerce_schema_migrations` is visible with columns `migration_name`, `checksum_sha256`, `apply_status`, and `applied_at`. A query for the exact source migration names 134 through 140 returned no rows. This does not establish schema absence; it means those source filenames are not recorded in the ledger visible to this reader.
- The 18 October recheck confirmed `public` schema `USAGE` is false for `shopit_accounting_audit` in `itc`. The reader can connect in a read-only transaction but cannot inspect those tables or the migration ledger; their state remains unverifiable.
- The refreshed `local_staging` COA shows account 1020 (`PawaPay Clearing – ZMW`) active and postable, 1100 (`Trade Receivables`) inactive and non-postable, 2000 (`Customer Advances / Unearned Sales`) active and postable, and 2020 (`Customer Credit Payable`) active and postable. A/R collection remains blocked by account 1100, apart from the unapplied A/R migrations.

No DDL/DML, migration, provider call, or financial posting was performed. Keep ITC finance operations and A/R collection disabled until an authorized reader can verify the migration records/checksums in both targets, the required COA accounts are ready, and the separate provider and transaction-readiness gates pass.

## Read-only rerun-error investigation — 18 October 2026

After the owner reported `relation already exists` errors while rerunning migrations 134 and 135, a further audit used only `node scripts/codex_db.js local_staging < query.sql` from the primary ITC checkout. The helper confirmed the `shopit_accounting_audit` role and read-only transaction. No DDL/DML, migration, provider request, or financial posting was performed.

- All five relations are regular tables with the exact source column names, order, types, nullability, and defaults. The read-only audit role has no table `SELECT` on these tables, so column evidence was read from PostgreSQL catalogs rather than business rows.
- All 51 constraints are validated; all 18 indexes are present; all eight migration-defined triggers are enabled.
- The inspected bodies of `claim_expense_warrior_service_nonce`, `guard_expense_warrior_fund_hold_transition`, `apply_treasury_ledger_entry`, and `guard_expense_warrior_customer_credit_entry` match the checked-out migration source. The two security-definer functions have `search_path` pinned to `pg_catalog, public`; `PUBLIC` has no execute permission and `itcstore_api` does.
- Runtime grants match the source: `itcstore_api` has select/insert on finance operations, holds, collection operations, and customer-credit entries; only `state` and `resolved_at` are updateable on holds; it has no direct privileges on the nonce table. The nonce claim function is executable by the API role.
- COA account 2020 still matches the active/postable `Customer Credit Payable` identity. The exact 134 and 135 migration ledger rows are still absent.

This is strong evidence that the local-staging DDL is already present and closely matches the current migrations, and explains why another plain `CREATE TABLE` fails. It is not ledger provenance: a matching schema does not establish which path created it or prove the expected source checksums were recorded. The ITC target remains unverified because the configured read-only role cannot access its `public` schema. The guarded commerce release code has a `VERIFIED_ADOPTION` route when a complete readiness check passes and the operator explicitly confirms it; recording adoption is a database write. Its release wrapper only accepts `staging` or `production`, so do not point it at `local_staging` or bypass it with manual ledger edits. Keep financial flags off until the exact target and approved reconciliation path are established.

## Manual SQL application and ledger adoption — 18 October 2026

The owner confirmed migrations 134 and 135 were run manually in Valentina Studio against `itc` and `local_staging`. A fresh catalog check confirms the five tables and migration 134/135 shape in `local_staging`; the current audit reader cannot verify the `itc` objects because it lacks `public` schema `USAGE`. PostgreSQL does not update `commerce_schema_migrations` when a SQL file is run manually; missing local ledger rows do not mean the migrations were not run.

The ITC backend now provides a targeted command, `npm run migrate:expense-warrior:adopt`, for this exact case. It validates the configured database and dedicated migration role, checks both 134/135 readiness predicates and source checksums, then records only missing `VERIFIED_ADOPTION` rows in one transaction. It does not rerun DDL. The command has not been run; see the [ITC integration guide](../../../itcstore-backend/docs/expense-warrior-integration-guide.md) for setup. Keep finance calls disabled until the owner runs it for each intended target and independently completes the account, provider, and operational readiness checks.
