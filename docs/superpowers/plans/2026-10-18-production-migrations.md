# Expense Warrior Production Migration Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Expense Warrior schema changes target-verifiable, previewable, explicitly applied, checksum-tracked, and post-verified without connecting Expense Warrior to ITC's database.

**Architecture:** Extend the existing Expense Warrior migration runner; keep API runtime credentials and migration credentials separate. Add a named-target identity contract, read-only status/plan commands, guarded per-migration apply, and post-apply verification. Continue to document ITC as a separate owner with its own migration/adoption tooling; this plan does not run or write ITC migrations.

**Tech Stack:** Node.js 20, CommonJS, PostgreSQL `pg`, dotenv, Node built-in test runner.

**Spec:** [Expense Warrior Loading, Error, and Migration Workflow Design](../../../../back/docs/superpowers/specs/2026-10-18-loading-errors-production-migrations-design.md)

## Global Constraints

- Runtime API credentials remain separate from migration credentials.
- Migration apply requires `CONFIRM_EXPENSE_WARRIOR_MIGRATIONS=APPLY` and a separate migration login.
- Status and plan use a read-only transaction and never create the ledger or execute DDL/DML.
- Each migration's DDL and matching checksum-ledger row commit in one transaction.
- Do not run migrations from API startup.
- Refuse wrong target identity, replica connections, checksum drift, incomplete schema without ledger, partial readiness, or lock contention.
- ITC remains the owner of its database, ledger, accounting, and finance APIs; Expense Warrior never connects directly to that database.
- No migration is applied or adopted and no provider operation is initiated during implementation validation.

## Review Focus

- Wrong environment with a valid-looking database name: assert host, port, database, session/current user, and primary status against the selected named target before any write.
- Existing schema without ledger: classify as manual review and refuse to initialize an empty ledger or replay DDL.
- First migration failure on a new empty target: assert ledger bootstrap and first migration roll back atomically.
- Duplicate runner: assert advisory-lock contention prevents a second writer.
- Source SQL edited after application: assert checksum drift blocks status/plan/apply/verify and never rewrites the recorded checksum.

---

### Task 1: Define exact migration target configuration

**Files:**
- Modify: `src/config/env.js`
- Modify: `.env.example`
- Create: `.env.migrations.example`
- Modify: `tests/env.test.js`
- Modify: `tests/migrate.test.js`

**Interfaces:**
- Consumes: existing `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_MIGRATION_USER`, and `DB_MIGRATION_PASSWORD`.
- Produces: `.env.migrations` fields `DB_MIGRATION_TARGET`, `DB_MIGRATION_ALLOWED_TARGETS`, `DB_MIGRATION_TARGET_HOST`, `DB_MIGRATION_TARGET_PORT`, `DB_MIGRATION_TARGET_DATABASE`, `DB_MIGRATION_USER`, and `DB_MIGRATION_PASSWORD`; validated settings `{ name, host, port, database, user }`; and `assertMigrationTargetIdentity(client, target)`. The selected name must be in the comma-separated allowlist and match the connected target tuple.

- [ ] **Step 1: Add failing environment tests** for missing target, target outside allowlist, incomplete expected identity, runtime/migration identity reuse, and an exact valid target tuple. Keep all fixtures fake and local; never load `.env` secrets into test output.
- [ ] **Step 2: Run `node --test tests/env.test.js tests/migrate.test.js`** from the backend repository root; confirm the new cases fail.
- [ ] **Step 3: Implement migration-only target parsing** without exposing migration credentials through normal `loadConfig()` calls. Compare `client.connectionParameters` and `current_database()`, `current_user`, `session_user`, and `pg_is_in_recovery()` with the selected target; reject replicas and all mismatches.
- [ ] **Step 4: Add placeholder-only `.env.migrations.example` values** and document that the real file is local-only and ignored by Git.
- [ ] **Step 5: Re-run the focused tests** and confirm target validation passes and runtime config still rejects migration credentials.
- [ ] **Step 6: Commit** the target configuration and its tests in the Expense Warrior backend repository.

### Task 2: Add identity-checked read-only status and plan commands

**Files:**
- Modify: `src/db/migrate.js`
- Modify: `package.json`
- Modify: `tests/migrate.test.js`

**Interfaces:**
- Produces: `inspectMigrations({ pool, target, directory }) -> { target, state, applied, pending, blockers }` and `planMigrations({ pool, target, directory }) -> { target, steps, blockers }`.
- `state` is one of `READY`, `NEW_EMPTY_DATABASE`, `MANUAL_REVIEW_REQUIRED`, or `BLOCKED`.
- Each step contains `name` and lowercase SHA-256 `checksum`.

- [ ] **Step 1: Add fake-pool tests** asserting status/plan use `BEGIN READ ONLY`/`ROLLBACK`, verify actual connection target and `pg_is_in_recovery()`, and issue no DDL/DML under success or failure.
- [ ] **Step 2: Add tests** for missing ledger on an empty target, missing ledger with existing application tables, duplicate/unknown ledger rows, valid checksums, and checksum mismatch.
- [ ] **Step 3: Implement `inspectMigrations`** to collect source files, inspect server/connection identity, classify ledger/schema state, and compare every recorded checksum without creating schema objects.
- [ ] **Step 4: Implement `planMigrations`** as a read-only projection of `inspectMigrations`, listing exact ordered filenames/checksums and blocking mismatches.
- [ ] **Step 5: Add `db:migrate:status` and `db:migrate:plan` CLI entries** that print structured, credential-free JSON and exit nonzero for blocked states.
- [ ] **Step 6: Run `node --test tests/migrate.test.js`** from the backend repository root and confirm the command paths issue no writes.
- [ ] **Step 7: Commit** read-only inspection and planning commands in the Expense Warrior backend repository.

### Task 3: Harden guarded apply and add post-apply verify

**Files:**
- Modify: `src/db/migrate.js`
- Modify: `tests/migrate.test.js`
- Create: `src/db/migrationPostconditions.js`
- Create: `src/db/migrations/verify/` read-only postcondition definitions for migration `0001` through `0016`

**Interfaces:**
- Consumes: validated target and `inspectMigrations` from Tasks 1–2.
- Produces: `verifyMigrations({ pool, target, directory }) -> { target, verified, blockers }`; each migration verifier returns a boolean readiness result and must be read-only.

- [ ] **Step 1: Add fake-pool tests** proving wrong identity, replica, drift, partial/no-ledger schema, and advisory-lock contention fail before migration SQL is sent.
- [ ] **Step 2: Add transaction tests** proving the first ledger creation on an empty database, each migration SQL, and that migration's ledger insert share the same transaction; an error rolls back both.
- [ ] **Step 3: Add postcondition coverage** for all 16 source migration files; test that a missing/false verifier blocks a verified result and that verifiers issue only SELECT/catalog reads.
- [ ] **Step 4: Refactor `runMigrations`** to call the target assertion and safe status classifier before any write, permit automatic ledger initialization only when the target is confirmed empty, retain advisory lock and checksum immutability, apply each migration transactionally, and record the exact checksum in the same transaction.
- [ ] **Step 5: Implement `verifyMigrations` and `db:migrate:verify`** to assert target identity, ledger/source checksum equality, and every migration postcondition without writes.
- [ ] **Step 6: Re-run `node --test tests/migrate.test.js`** from the backend repository root; verify all unsafe preconditions block and all safe mock sequences pass.
- [ ] **Step 7: Commit** guarded apply, verification, postconditions, and tests in the Expense Warrior backend repository.

### Task 4: Document operator runbook and coordinate ITC boundary

**Files:**
- Create: `docs/database-migrations.md`
- Modify: `README.md`
- Modify: `docs/itc-finance-service-contract.md`
- Reference only: `../../itcstore-backend/docs/expense-warrior-integration-guide.md`

- [ ] **Step 1: Document exact commands** for status, plan, apply, and verify; required target variables; approved migration role; expected safe output; backup/recovery checkpoint; and stop conditions.
- [ ] **Step 2: Document missing-ledger recovery**: status/plan stop for non-empty schemas, no manual ledger insert, no replay; owner reviews and authorizes the separately guarded ITC-owned adoption process when the database is ITC-owned.
- [ ] **Step 3: Document staging sequence**: review artifact/checksum, backup, target preflight, human-reviewed plan, explicit apply, postcondition verification, then compatible API/frontend rollout.
- [ ] **Step 4: Document forward-repair expectations** for migrations that cannot safely roll back; never delete a ledger row or edit an applied migration to simulate rollback.
- [ ] **Step 5: Run `git diff --check`** and review the docs for secret values or commands that target the wrong database owner.
- [ ] **Step 6: Commit** the operator runbook and ownership-boundary updates in the Expense Warrior backend repository.

### Task 5: Verify source-only implementation and handoff

- [ ] **Step 1: Run `node --test tests/migrate.test.js tests/env.test.js`** from the backend repository root.
- [ ] **Step 2: Run `npm test`** from the backend repository root; report existing failures separately.
- [ ] **Step 3: Run `npm run build`** from the frontend repository root after UI work is complete and browser-check UI flows per the companion frontend plan.
- [ ] **Step 4: Confirm no direct ITC DB configuration was added to Expense Warrior and no migration, adoption, financial write, or provider call was run.**
- [ ] **Step 5: Commit the implementation** in the Expense Warrior backend repository and link the operator runbook from the ITC integration guide when the corresponding repository branch is reviewed.
