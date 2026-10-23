# Expense Warrior Membership Implementation Plan

> **For agentic workers:** Use the approved design in `../specs/2026-10-23-itc-expense-warrior-membership-design.md`. Execute task by task with focused tests and commits on the existing repository branches.

**Goal:** Let existing ITC accounts use Expense Warrior through its own app membership and session audience without granting or changing Shop.IT roles.

**Architecture:** ITC owns the membership row, authentication audience, authorization checks, admin management API, and enrolled-member directory. The `has_pettycash_access` boolean and `admin`/`staff` role live together in one ITC membership row; ITC audit history records each change. Expense Warrior consumes only the dedicated audience cookie and server-verified app role. Its manager assignments and petty-cash data remain in its own database.

**Tech Stack:** ITC Node/Express/PostgreSQL and Vue backoffice; Expense Warrior Node/Express and Vue/Vite; existing ITC password, 2FA, refresh-token, cookie, and audit services.

**Spec:** `back/docs/superpowers/specs/2026-10-23-itc-expense-warrior-membership-design.md`

## Global Constraints

- Reuse ITC credentials, password verification, 2FA, refresh/session services, and identity rows.
- Expense Warrior membership alone grants no Shop.IT staff, vendor, finance, order, inventory, or backoffice permissions.
- ITC returns `expense_warrior_role` only when `has_pettycash_access` is true and the account is active.
- ITC rechecks membership for every Expense Warrior session resolution; lookup failure denies access.
- Enroll existing active accounts only; account creation stays in the existing ITC provisioning flow.
- Expense Warrior stores no ITC password or bearer token and uses no browser local/session storage for auth.
- Author the additive migration and release artifact only; do not apply/adopt migrations, change DB rows, or enable payment/finance operations.
- Keep existing branches and preserve all pre-existing changes, including ITC `tsconfig.json` edits.

## Review Focus

- Enrolled global `customer` and `vendor` identities must authenticate only through the Expense Warrior audience and must fail Shop.IT staff/admin routes.
- An Expense Warrior cookie without the matching audience must not authenticate; no cookie fallback may cross app audiences.
- Missing, false, malformed, or unavailable membership must deny the Expense Warrior session and API client.
- A membership revocation must stop the next session check and the next refresh; pending 2FA must recheck membership before issuing cookies.
- Manager directory results must contain only active enrolled accounts, with bounded search/pagination and minimum identity fields.

---

### Task 1: ITC membership schema and membership service

**Files:**
- Create: `itcstore-backend/src/migrations/150_expense_warrior_memberships.sql`
- Create: `itcstore-backend/src/services/expenseWarriorMembershipService.js`
- Modify: ITC migration registry/release manifest and migration contract test discovered during implementation
- Test: `itcstore-backend/tests/expenseWarriorMembershipMigration.test.js`
- Test: `itcstore-backend/tests/expenseWarriorMembershipService.test.js`

**Interfaces:**
- Produces `getMembership(customerId, runner?)`, `listActiveMembers(filters, runner?)`, and `setMembership({customerId, hasPettycashAccess, role, actorCustomerId, requestMeta})`.
- `setMembership` changes membership and app audit event atomically; it refuses missing/inactive accounts and roles outside `admin|staff`.

- [ ] Test migration guards, membership constraints, runtime grants, service revocation state, and atomic audit behavior with isolated clients.
- [ ] Run focused tests and confirm they fail against missing service/schema.
- [ ] Add the additive table keyed by `customer_id`, boolean `has_pettycash_access`, constrained `expense_warrior_role`, grant/update actor IDs, and timestamps; add indexed active-directory lookup and the least-privilege runtime grant.
- [ ] Implement membership reads and transactional audited upsert; use the existing ITC audit service with the same transaction client.
- [ ] Register migration 150 in the repository's guarded numbered migration/release path without applying it.
- [ ] Run the two focused tests and `git diff --check`.

### Task 2: ITC isolated authentication audience and directory

**Files:**
- Modify: `itcstore-backend/src/utils/sessionCookies.js`
- Modify: `itcstore-backend/src/services/authService.js`
- Modify: `itcstore-backend/src/controllers/customers/customerController.js`
- Modify: `itcstore-backend/src/routes/authRoutes.js`
- Modify: `itcstore-backend/src/middleware/auth.js`
- Modify/add: ITC focused auth/audience/directory tests

**Interfaces:**
- Adds `POST /auth/expense-warrior/login` using existing password and 2FA verification.
- Adds `GET /auth/expense-warrior/directory`, available only to an active Expense Warrior `admin` session, returning active enrolled members with `customer_id`, `email`, `first_name`, `last_name`, and app role.
- `GET /auth/session`, `POST /auth/refresh`, `POST /auth/logout`, and `/customers/2fa/verify` honor audience `expense_warrior` and its separate cookies.

- [ ] Add failing tests for cookie isolation, role isolation, enrolled/unenrolled login, 2FA revocation, refresh revocation, and directory authorization/filtering.
- [ ] Run focused tests to confirm the failures.
- [ ] Add `itc_expense_warrior_access` and `itc_expense_warrior_refresh`; bind them only to inferred/requested audience and do not fall back to them for Shop.IT routes.
- [ ] Include the audience in newly issued JWTs and block Expense Warrior-audience credentials from ordinary ITC routes; preserve global `role` unchanged.
- [ ] Return `expense_warrior_role` separately after a live membership check on session resolution; recheck membership during refresh and after 2FA.
- [ ] Restrict member directory to active, enrolled memberships and admin app role; validate search, UUID filters, and bounded pagination.
- [ ] Run focused auth tests plus existing cookie/session and auth route suites; review cross-app access tests.

### Task 3: ITC global-admin membership management UI

**Files:**
- Modify: `itc-store-backoffice/src/pages/accounts/AccountManagement.vue`
- Modify: existing account store/API module used by AccountManagement
- Test: existing account-management UI tests or a focused membership-control regression test

**Interfaces:**
- Account list/detail exposes `has_pettycash_access` and `expense_warrior_role` for a global ITC admin.
- Global ITC admins can enable/disable access and choose `admin`/`staff`; non-admin routes remain protected by existing ITC admin APIs.

- [ ] Add a failing UI/API assertion for status, role changes, disabled-account handling, and save errors.
- [ ] Add the account-management toggle and role selector using the existing authenticated API client; show the saved state returned by ITC.
- [ ] Run backoffice unit/build checks and inspect the account modal at mobile and desktop widths when browser tooling is available.

### Task 4: Expense Warrior API consumes the dedicated audience

**Files:**
- Modify: `expense-warrior/back/src/auth/cookieCsrfGuard.js`
- Modify: `expense-warrior/back/src/auth/requireItcSession.js`
- Modify: `expense-warrior/back/src/integrations/itc/ItcIdentityClient.js`
- Modify: associated unit/route tests

**Interfaces:**
- ITC identity client extracts only `itc_expense_warrior_access`, sends `X-Session-Audience: expense_warrior`, validates `expense_warrior_role`, and maps it to Expense Warrior `actor.role`.
- Expense Warrior API requires the Expense Warrior cookie and rejects absent/invalid app membership; CSRF protection remains origin-bound for that cookie.
- Staff/manager directory calls use the dedicated app-role directory endpoint.

- [ ] Add failing tests for exact cookie extraction, role mapping, invalid/missing app role, CSRF, and existing routes with the new cookie.
- [ ] Implement the audience-specific identity contract and cookie guard.
- [ ] Run API unit tests and integration/route suites without database writes.

### Task 5: Expense Warrior frontend login, session, and logout

**Files:**
- Modify: `expense-warrior/front/src/api/auth.js`
- Modify: `expense-warrior/front/src/auth/session.js`
- Modify: existing frontend auth-cookie/2FA tests

**Interfaces:**
- Login, session restore, 2FA verify, refresh, and logout use `X-Session-Audience: expense_warrior` and cookie-only responses.
- Frontend authorization uses the server-verified app role/capabilities; no credentials are written to Web Storage.

- [ ] Add failing tests for the exact login/session/logout audience headers, role behavior, two-factor transition, and no-storage invariant.
- [ ] Switch the frontend to the dedicated ITC audience while keeping the same sign-in form and 2FA flow.
- [ ] Run the full frontend suite and production build; browser-check sign-in, restore, role-specific navigation, and logout if the ITC migration is available in the local environment.

### Task 6: Cross-repo contract and rollout review

**Files:**
- Modify: `expense-warrior/docs/itc-expense-warrior-shared-handoff.md`
- Modify: `itcstore-backend/docs/expense-warrior-integration-guide.md`

- [ ] Document the approved field/session/directory contract and migration-only status without secrets.
- [ ] Verify no Shop.IT route accepts the Expense Warrior audience and no Expense Warrior client accepts backoffice-only identity as membership.
- [ ] Run focused ITC, Expense Warrior API, and frontend validation, then review all affected diffs.
- [ ] Record migration application, admin enrollment, browser E2E, and provider operations as separate owner-controlled gates; do not perform them in this implementation.
