# ITC migration 134–135 verification

**Date:** 2026-10-15
**Targets requested:** `itc`, `local_staging`
**Purpose:** verify the reported Expense Warrior finance schema without changing database state.

## Method

Used the backend's `scripts/codex_db.js` with the configured read-only `shopit_accounting_audit` role. The helper asserted the selected database and role, accepted only a single `SELECT`/read-only `WITH`, ran it in a read-only transaction, and capped returned rows. No credentials or secret values were printed.

## Results

| Database | Expected migration objects | Migration ledger/checksum | COA check |
|---|---|---|---|
| `itc` | PostgreSQL catalogs show `commerce_schema_migrations` and all five expected Expense Warrior tables: `expense_warrior_finance_operations`, `expense_warrior_fund_holds`, `expense_warrior_service_nonces`, `expense_warrior_collection_operations`, and `expense_warrior_customer_credit_entries`. | The configured audit role cannot read the public schema (`permission denied for schema public`), so migration names, checksums, and `APPLIED` state could not be checked. | Not checked; the same schema permission boundary applies. |
| `local_staging` | PostgreSQL catalogs show the same five expected Expense Warrior tables and `commerce_schema_migrations`. | Queries for names matching migration 134, migration 135, or `expense_warrior` returned no rows. Therefore, the migration ledger does not currently provide application/checksum evidence for these files. | Account 2020 is `Customer Credit Payable`, `LIABILITY`, active and postable. Account 1020 is active/postable. Account 1100 `Trade Receivables` is inactive and non-postable. |

The `itcstore_api` runtime role was also checked through PostgreSQL privilege catalogs in both databases. It has `USAGE` on `public`; `SELECT` and `INSERT` on the finance operations, fund holds, collection operations, and customer-credit entry tables; column-level `UPDATE` only for hold `state` and `resolved_at`; and `EXECUTE` on the nonce-claim and treasury-ledger functions. It has no direct privilege on the service-nonce table. This matches the grants declared by the migration sources. The check verifies current privileges but does not establish which migration file produced them.

The source manifest currently pins these migration checksums:

- `134_expense_warrior_treasury_holds.sql`: `7fca968c587ad8524ce12e261dd16725ad28f2d96ba2a2b4d44f6d4225622a2a`
- `135_expense_warrior_collections.sql`: `2759465bcbaf5246fdd8f4408eabb59d23b5d91a572eeee4f0f00ad9d8be003e`

The catalog results confirm that the expected schema objects exist in both requested databases. They do **not** prove that the exact source files above were applied and recorded with matching checksums. In `local_staging`, the relevant migration ledger rows are absent. In `itc`, the configured reader cannot inspect the ledger. This is consistent with the owner's report that the migrations were applied, but not sufficient to verify the guarded release record.

## Operational boundary

No migrations, database writes, payment-provider calls, or financial postings were performed for this check. Keep finance operations gated until a least-privilege audit reader can verify the two migration ledger entries and checksums in both targets, then complete the existing account/provider and transaction-readiness review. The inactive/non-postable 1100 account is a separate prerequisite for the approved A/R feature; migrations 134–135 do not establish that A/R workflow.
