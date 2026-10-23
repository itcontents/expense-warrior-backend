# Expense Warrior Loading, Error, and Migration Workflow Design

**Date:** 2026-10-18
**Status:** Draft for owner review
**Scope:** Expense Warrior frontend and its own API/database; documented coordination with the ITC commerce migration runner. This design does not authorize a database migration, provider call, or production deployment.

## 1. Goals

- Make the initial app startup feel deliberate and branded, with a centered loading state that works on phones and desktops.
- Make in-app data loading readable without repeatedly replacing the whole workspace with a splash screen.
- Give users consistent, concise error messages and a safe next step while keeping provider, database, and internal error details out of the interface.
- Make schema rollout repeatable and verifiable across two distinct database owners: Expense Warrior and ITC.
- Preserve the existing rule that only an explicitly authorized operator may apply or adopt migrations for an exact target.

## 2. Current behavior and constraints

### Frontend

- `front/src/App.vue` already has a centered session bootstrap state and a retry view. Its visual treatment is minimal.
- Workspace and wallet panels use plain inline loading text. Different views render error messages independently.
- `front/src/api/http.js` preserves the backend message and error code. Some views need the code for safe recovery logic; presentation should not depend on displaying raw backend wording.
- The admin Overview has been browser-checked at a 390px viewport. The loaded overview is verified; the startup splash and error states have not yet received browser verification.
- Keep app surfaces task-focused. Do not add explanatory engineering copy, generic security disclaimers, or repeated status prose to ordinary screens.

### Expense Warrior database

- The API has a separate migration runner in `back/src/db/migrate.js`. It already requires a separate migration login, an explicit `CONFIRM_EXPENSE_WARRIOR_MIGRATIONS=APPLY` value, a PostgreSQL advisory lock, SHA-256 checksums, and one transaction per migration.
- The runner exposes `db:migrate` only. It does not expose a read-only status/plan command or assert the connected database identity after connecting.
- Runtime API credentials are intentionally separate from migration credentials. Migrations do not run during API startup.

### ITC database

- ITC owns its schema, accounting, treasury, and finance API. Expense Warrior must not connect directly to ITC's database.
- ITC has separate preflight, verify, apply, release, and verified-adoption paths. The existing guarded adoption path for migrations 134 and 135 checks the exact target, role identity, checksums, and schema readiness, then records `VERIFIED_ADOPTION` without replaying DDL.
- The owner reported applying migrations 134 and 135 manually. A read-only check found no corresponding rows in the `local_staging` migration ledger; the approved `itc` reader cannot inspect that ledger. This is a provenance gap, not evidence that DDL should be replayed.
- Inactive/non-postable account 1100 and unverified ITC migrations remain independent gates for A/R collection. No workflow in this design changes accounting readiness or enables finance flags.

## 3. Frontend experience

### Startup splash

Use the centered splash only while the app is restoring the ITC session and resolving the protected application route. Give it the Expense Warrior mark/wordmark, one short status line, and a compact indeterminate progress indicator. Center the group in the available viewport, including mobile safe-area space. Keep contrast accessible, respect reduced-motion preferences, and avoid marketing copy or full-screen decorative artwork.

When session restoration fails, retain the same centered brand alignment and replace the progress indicator with a concise error state and one retry action. Explain the user impact (for example, that the workspace could not be reached), not the implementation detail. A 401/403 follows the existing sign-in routing behavior and is not presented as a service outage.

### In-workspace loading

Do not use the startup splash for routine refreshes or navigation between already-mounted views. Use placeholders sized to the content being fetched:

- Overview: preserve wallet and request section geometry while their first reads are pending.
- Queues and histories: show a small set of row placeholders in the expected list shape; preserve existing content during background refresh.
- Buttons: show a local busy state and prevent duplicate submission while an action is in progress.
- Load-more actions: keep existing rows visible and mark only the appended region as loading.

When data already exists, retain it during refresh and show its freshness where that matters (for example provider balance). Avoid skeleton animation when reduced motion is requested. Every loading state has an accessible status announcement and does not move keyboard focus.

### Error presentation

Keep `ApiError.code`, HTTP status, and safe details available to application logic. Add one presentation layer that maps known conditions into product copy and recovery actions. Do not show arbitrary `error.message`, upstream provider text, SQL/database messages, tokens, callback bodies, or stack traces.

| Condition | User-facing behavior |
| --- | --- |
| Network failure / API unavailable | State that the data could not be reached; offer retry when retry is safe. Keep existing data visible if available. |
| Session expired / unauthorized | Route to ITC sign-in or show the existing sign-in recovery; do not label it a server failure. |
| Forbidden | Explain briefly that the current account cannot perform the action; do not offer a retry that cannot change authorization. |
| Validation / business rule (400, 409, 422) | Keep the form values, identify the relevant correction, and do not retry automatically. |
| Provider balance refresh failure | Keep the last observation with its timestamp and mark it stale; never present it as fresh. |
| Financial outcome unknown / pending | Use the operation-specific recovery flow. Do not invite a second payment or payout; preserve the existing idempotency identity and direct the user to check status/reconciliation. |
| Unexpected server error | Use concise generic copy and a safe retry only for idempotent/read operations. Record a correlation identifier if the API provides one. |

Inline field errors remain beside fields; page-level read failures use a compact recovery region; action failures stay next to the affected action. The same error is not repeated in a toast, banner, and page footer.

## 4. Migration and release workflow

### Expense Warrior-owned schema

Keep the existing direct apply-and-track runner as the only migration writer for the Expense Warrior database. Extend its operator interface with distinct read-only planning/status and explicit apply operations:

1. **Preflight/status:** connect in a read-only transaction; assert the actual database, user/role, server primary status, and expected target; list applied and pending migrations; verify checksums and required readiness evidence. This command must not create the migration ledger or execute DDL.
2. **Plan:** output the exact ordered migration filenames and checksums that would be applied, current/pending state, target identity, and any blocking mismatch. It is also read-only.
3. **Apply:** require an explicitly supplied environment target resolved through an allowlisted target configuration; verify the connected PostgreSQL database and identity against that target before writing. Keep the separate migration login, fail-fast advisory lock, checksum immutability, bounded lock/statement timeouts, and per-migration transaction. Record a migration only in the same transaction as its DDL. Never start migrations from API boot.
4. **Verify:** after apply, re-read the target identity, ledger, checksums, and migration-specific postconditions. Fail closed on missing ledger entries, drift, partial schema, replica connections, wrong target, or unavailable checks.

If a database contains application schema objects but has no ledger, status/plan reports a manual-review state and apply refuses to create an empty ledger and replay the migration. The ledger may be initialized automatically only for a confirmed empty, new target. A separate, narrowly scoped adoption operation may be added only for an explicitly reviewed case; it must prove complete schema readiness and exact source checksum before recording provenance without running DDL. It must be idempotent and separately authorized.

Production operation should be staged: reviewed migration artifact and checksum; backup/recovery checkpoint; preflight against the named target; human review of the plan; explicit apply; post-apply verification; then application rollout. Prefer additive/expand-contract changes. Where safe rollback is not possible, document the forward-repair procedure. Never promise rollback by deleting ledger rows or editing an applied migration.

### ITC-owned schema

Continue to use ITC's own commerce migration and release commands. Do not create an Expense Warrior script that writes ITC tables, and do not manually insert ITC migration ledger records.

- For normal releases, use ITC's exact-target preflight, reviewed migration release wrapper, and post-apply verification.
- If an owner has already run approved DDL manually (as reported for 134/135), inspect the target through the permitted read-only path and use ITC's guarded `VERIFIED_ADOPTION` workflow only when its complete readiness, checksum, identity, and target checks pass. Adoption is itself a database write and requires explicit approval for that exact database and operation.
- If the reader cannot inspect the ledger or readiness predicates, stop and provision/authorize the appropriate read-only access or have the database owner perform the verification. Do not infer tracking state from a Valentina success message or the existence of a few tables.
- Keep finance flags and provider operations disabled until migration provenance, treasury/account mappings, account readiness, and signed-request configuration are verified for the deployment target.

### Coordinated release order

1. Review and verify ITC schema/API prerequisites first; apply or adopt only through the ITC-owned path and authorized target.
2. Verify ITC service contracts and finance configuration without initiating a provider transaction.
3. Preflight, plan, and apply Expense Warrior-owned migrations through its own runner.
4. Deploy the backward-compatible API, verify readiness and logs, then deploy the frontend.
5. Keep collection/payout feature flags off until an explicit enablement review. Provider sandbox/production transactions are separate operations and are not part of schema release.

## 5. Security and financial invariants

- No credentials, mobile-money PINs, full payout phone numbers, raw provider responses, SQL, or stack traces in browser storage or user-facing errors.
- The browser continues to use the HttpOnly ITC session cookie. Error normalization must not put authentication or financial data into local/session storage.
- The API remains authoritative for authorization. Frontend error handling and hidden actions are not security controls.
- Migration status and plan commands are read-only and must use the approved database access boundary for their target. Hooks and environment confirmation flags are guardrails; database grants and exact target verification are the enforcement boundary.
- A payment or payout in an unknown state remains unresolved and retains its reservation. Migration tooling must never trigger provider operations or mutate ledger/business data.

## 6. Acceptance and validation

### UI

- Browser-check startup loading, recoverable session failure, successful sign-in routing, and retry at phone widths (320px and 390px) and desktop width (1280px).
- Confirm the splash group is visually centered in the available viewport, respects safe areas/reduced motion, and has no layout overflow.
- Check a page's first-load, background-refresh, empty, and error states. Existing rows remain visible during refresh.
- Exercise network, 401/403, validation, conflict, provider stale-balance, unexpected API, and unknown financial outcome cases. Confirm concise copy, no raw provider/SQL details, correct recovery action, and no duplicate financial submission.
- Verify keyboard focus, screen-reader status announcements, and no console errors or failed asset requests.

### Migrations

- Unit-test runner target assertions, read-only plan/status behavior, source checksum changes, already-applied checksums, ledger/schema mismatch, failed DDL rollback, advisory-lock contention, and postcondition failures with disposable PostgreSQL or controlled test doubles.
- Prove plan/status issue no DDL or persistent writes. Prove apply writes each migration and matching ledger row atomically, and refuses unknown/partial/adopted schema states.
- Test ITC adoption only through unit/disposable-database coverage; do not run it on `itc`, `local_staging`, staging, or production as part of implementation validation.
- Document exact operator commands, target selection, required role, expected output, backup checkpoint, stop conditions, post-apply verification, and forward-repair escalation.

## 7. Risks and deferred items

- **UI risk — medium:** global styles can make the splash appear centered in one viewport but not under mobile safe areas or tall content. Verify actual browser geometry at multiple sizes.
- **Error risk — medium:** normalizing messages too broadly could hide actionable business validation or mislead users about unknown financial outcomes. Keep codes and statuses in logic and cover each class with tests.
- **Migration risk — high:** the current Expense Warrior runner lacks an explicit target identity assertion and dry-run/status workflow. Do not use it for production until these are implemented and tested.
- **ITC data/provenance risk — high:** the approved reader cannot inspect the `itc` ledger and local staging has no recorded 134/135 entries. Adoption must remain pending until target-specific verification and authorization.
- **Financial risk — high:** this design does not resolve A/R account 1100 readiness or verify migration 136–140. Keep A/R and provider flags gated until the ITC owner resolves those separate prerequisites.
- **Out of scope:** applying/adopting migrations; enabling PawaPay flags; creating sandbox or production deposits, payouts, or refunds; changing accounting mappings; changing authentication contracts; replacing ITC's migration system.

## 8. Proposed implementation areas

- `front/src/App.vue`, `front/src/styles.css`: startup splash and retry presentation.
- `front/src/api/http.js` plus a small frontend error-presentation module: normalized safe messages while preserving error codes.
- `front/src/views/WorkspaceView.vue`: loading placeholders and consistent contextual error states, prioritized by visible views.
- `back/src/db/migrate.js`, `back/src/config/env.js`, `back/package.json`, migration tests/docs: target assertion, read-only status/plan, explicit apply flow, and operator runbook.
- ITC integration documentation only: cross-reference the existing ITC-owned release/adoption boundary; no ITC migration code or database operation in this phase.

## 9. Alternatives considered

1. **Keep the current behavior and only restyle the centered session loader.** Smallest change, but it leaves plain in-workspace loading and inconsistent error recovery untouched.
2. **One shared migration command that writes both Expense Warrior and ITC schemas.** Rejected because it crosses database ownership and conflicts with ITC's existing release/adoption safeguards.
3. **Separate front/API behavior and separate database-owned workflows (recommended).** It improves the user experience while preserving ITC's authority and makes every write target-specific and auditable. The trade-off is two operator paths, which must be made explicit in the runbook.
