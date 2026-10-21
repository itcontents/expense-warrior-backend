# Expense Warrior database migrations

Expense Warrior owns only its own PostgreSQL database. The API never connects directly to the ITC database; ITC schema changes, finance posting, and migration-ledger adoption remain inside `itcstore-backend` and its owner-approved tools.

The migration runner has four operator commands. `status`, `plan`, and `verify` use a read-only transaction and do not create the migration ledger or run DDL/DML. `apply` is the only writer. No command runs automatically during API startup.

## Configure a named target

Keep runtime credentials in `.env`. Keep the separate migration login and exact selected target in the ignored `.env.migrations` file:

```sh
cp .env.migrations.example .env.migrations
```

Set `DB_MIGRATION_TARGET`, `DB_MIGRATION_ALLOWED_TARGETS`, `DB_MIGRATION_TARGET_HOST`, `DB_MIGRATION_TARGET_PORT`, `DB_MIGRATION_TARGET_DATABASE`, `DB_MIGRATION_USER`, and `DB_MIGRATION_PASSWORD`. Every target must use an `expense_warrior` database name and the exact `expense_warrior_migrator` role; known ITC database names and other roles are rejected. The selected target must be allowlisted and match the actual connection parameters and PostgreSQL's reported database, current role, session role, `public` schema, exact `public, pg_temp` search path, and primary status. The migration role must differ from the runtime `DB_USER`.

When more than one name is allowlisted, also set `DB_MIGRATION_TARGETS_JSON` to a JSON object mapping every allowed name to its exact `host`, `port`, `database`, and `user`. The selected tuple must match that map. The connection itself uses `DB_HOST`, `DB_PORT`, and `DB_NAME` from `.env`; set these for the same selected Expense Warrior target. Do not use this runner for `itc`, `local_staging`, or ITC staging. Do not put `shopit_dba` or any `*_ADMIN_DB_*` identity into this file.

The migration connection pins its session search path to `public, pg_temp`: unqualified migration objects go into `public`, and temporary objects cannot shadow them. Preflight inventories application objects across user schemas, including empty custom schemas, tables, partitions, views, materialized views, foreign tables, sequences, indexes, functions, and user-defined types. It blocks a database with existing objects but no migration ledger. The migration role must not be a superuser or have `CREATEDB`, `CREATEROLE`, replication, or `BYPASSRLS` privileges. It needs catalog and ledger reads for preflight and only the DDL privileges required by Expense Warrior migrations on this database. Keep it out of the API process and do not commit `.env.migrations`.

If an existing migration ledger is owned by another role, the database owner must grant `SELECT` on only `public.expense_warrior_schema_migrations` to `expense_warrior_migrator` before `status`, `plan`, and `verify` can inspect it. Do not grant read access to every application table. Review the ledger and object ownership before applying migrations; the migration role must have only the ledger-write and DDL rights needed for the reviewed pending migrations.

## Review and apply

Run commands from the backend repository root:

```sh
npm run db:migrate:status
npm run db:migrate:plan
```

Review the JSON target, migration filenames, SHA-256 checksums, pending set, and blockers. Expected safe states are `NEW_EMPTY_DATABASE` before the first install and `READY` for a schema with a valid ledger. `READY` can include pending migrations; the plan shows their exact order and checksums.

Before applying to a shared or production environment:

1. Review the migration source and checksum in the release artifact.
2. Take and verify the database backup or recovery checkpoint.
3. Run status and plan against the exact named target.
4. Have an operator review the target tuple and pending list.
5. Apply with explicit confirmation:

   ```sh
   CONFIRM_EXPENSE_WARRIOR_MIGRATIONS=APPLY npm run db:migrate:apply
   ```

6. Verify checksums and schema postconditions:

   ```sh
   npm run db:migrate:verify
   ```

7. Roll out a compatible API build, check readiness and logs, then deploy the frontend.

The runner asserts target identity before obtaining a non-blocking advisory lock. It rechecks schema and checksums while holding that lock, refuses replicas and unknown/duplicate ledger entries, and blocks schema objects that are ahead of or incomplete relative to the ledger. Postconditions check that expected indexes are valid and ready, required append-only triggers are enabled, and the payout retry index remains unique with its exact active-state predicate. The payout retry check constraints must remain present, validated, and consistent with the migration's allowed states. Each migration and its checksum row commit in one transaction. On a confirmed empty database, creation of the ledger and the first migration share the same transaction. Lock and statement timeouts are bounded. A failed transaction rolls back without adding a ledger row.

## Stop and recovery rules

Stop if target identity fails, the connection is a replica, the lock is held, checksums differ, the schema is non-empty without a ledger, a ledger is empty or inconsistent, or a migration postcondition fails. Do not insert ledger rows by hand, delete ledger rows, edit an applied migration to simulate rollback, or replay DDL over an existing schema.

For non-empty schemas without migration history, collect read-only status evidence and have the database owner review the exact migration artifact and schema. There is no automatic adoption path for Expense Warrior. For an ITC database, use only ITC's own release or verified-adoption workflow after owner approval; this runner will not adopt or write ITC ledger rows.

If a migration fails, the current migration's transaction is rolled back. Preserve the error code and database logs, confirm the target remains at its last recorded migration, and repair forward with a reviewed new migration when necessary. Some schema operations do not have a safe rollback; do not promise restoration by deleting a tracking row. For a recovery-point restore, coordinate a full database restore with the database owner and reconcile application writes made after the checkpoint before reopening traffic.

Status and plan output is not authorization to apply. `CONFIRM_EXPENSE_WARRIOR_MIGRATIONS=APPLY` is an operator guardrail, while the separate database role grants and the exact target assertions enforce the connection boundary.
