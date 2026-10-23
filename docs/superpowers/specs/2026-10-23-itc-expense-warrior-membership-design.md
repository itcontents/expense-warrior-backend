# ITC Expense Warrior Membership Design

**Status:** Draft for owner review  
**Date:** 2026-10-23

## Intent

Allow company petty-cash users to use Expense Warrior with their existing ITC identity and login, while keeping Expense Warrior authorization separate from Shop.IT permissions. ITC remains the source of truth for identity and app membership; Expense Warrior remains the source of truth for petty-cash requests, manager assignments, payout destinations, approvals, and audit history.

## Goals

- Reuse existing ITC credentials and session cookies; do not create a second password store.
- Explicitly enroll users into Expense Warrior with an app-specific role: `admin` or `staff`.
- Ensure Expense Warrior membership alone grants no Shop.IT staff, vendor, finance, order, inventory, or backoffice capabilities.
- Let an existing ITC administrator grant, change, deactivate, and audit memberships.
- Return only enrolled, active members in the Expense Warrior staff directory.
- Make revocation effective on the next authenticated Expense Warrior request/session check.
- Keep Expense Warrior’s existing manager-scoped authority and local workflow data in its own database.

## Non-goals

- Changing the global ITC `customers.role` to make someone an Expense Warrior user.
- Giving Expense Warrior staff general ITC backoffice access.
- Replacing ITC authentication or storing passwords/tokens in the Expense Warrior database or browser local storage.
- Adding a multi-tenant membership model in V1; the current product is for one company.
- Applying a migration, changing a live account, or enabling finance/payment operations as part of this design.

## Approaches considered

1. **Reuse ITC global `staff` role.** This matches existing backoffice login and staff-directory assumptions, but grants a broad Shop.IT role used by unrelated order, finance, return, shipping, and stock routes. Rejected for least-privilege risk.
2. **Use a verified company-vendor staff scope.** This might avoid a new role table, but current account creation and directory filters disagree about `parent_vendor_id`, and route isolation has not been fully established. Rejected until ownership and every relevant authorization boundary are proven.
3. **Add explicit ITC Expense Warrior membership while preserving the global role.** The user selected this approach. It requires an additive ITC schema and coordinated auth, admin, and directory API changes, but keeps one identity and isolates app permissions.

## Membership data and ownership

ITC owns an additive `expense_warrior_memberships` record keyed by the existing ITC `customer_id`. V1 roles are `admin` and `staff`. The record includes active/revoked state, created/updated timestamps, and the ITC administrator identity that granted or changed it. Membership changes use an ITC audit event with old/new role and state; credentials and session tokens are never copied into this table.

There is one company membership scope in V1. If the product later serves multiple legal companies, add an explicit company/tenant key with a reviewed migration rather than inferring tenancy from Shop.IT vendor relationships.

Only an existing ITC global administrator may manage Expense Warrior membership. V1 membership management enrolls existing active ITC accounts only; account creation/invitation remains in the existing ITC account-provisioning flow. That administrator grants the first Expense Warrior admin from the ITC account-management surface. There is no automatic enrollment of all ITC administrators and no self-enrollment or self-approval. Removing or deactivating membership prevents future Expense Warrior authorization; existing ITC authentication remains unchanged for other applications.

## Authentication and authorization contract

- Continue to use ITC credentials, password verification, 2FA, refresh/session services, and identity rows. Expense Warrior does not receive or persist bearer tokens in local storage.
- **Proposed session boundary, pending owner approval:** add an `expense_warrior` audience with its own access/refresh cookie names, using the existing ITC sign-in and session machinery. This keeps credentials and auth implementation shared while preventing the Expense Warrior session from being mistaken for a Shop.IT backoffice session. ITC's audience inference, refresh handling, logout, and cookie helpers must explicitly support this audience; generic token extraction must not silently treat the Expense Warrior cookie as a backoffice cookie.
- The Expense Warrior audience login accepts only an active enrolled member after the existing password and 2FA checks. It must not turn an enrolled global `customer` or `vendor` into a general Shop.IT backoffice user. ITC's existing backoffice login and customer login behavior remain unchanged.
- Session resolution returns the existing identity plus an explicit `expense_warrior_role` (`admin` or `staff`) only when membership is active. It never substitutes that value into the global `role` field.
- ITC checks current membership when resolving every Expense Warrior session request, so disabling membership is effective on the next server-side check. Membership service failure fails closed for Expense Warrior access. Do not rely only on a role embedded in a long-lived access token.
- Expense Warrior’s identity client accepts only the Expense Warrior audience session and its app-specific role, then maps that role to its existing actor role. A global ITC role alone is insufficient to authorize Expense Warrior.
- ITC's existing route authorization continues to use the global ITC role. Expense Warrior role claims must not satisfy Shop.IT `requireRole` checks.
- Admin-only membership management is guarded by ITC global admin authorization, validated inputs, CSRF/session protections used by ITC, rate limits where appropriate, and audit records.

## Directory and workflows

The ITC Expense Warrior directory returns only active, explicitly enrolled users and only the minimum identity fields required by Expense Warrior (stable customer ID, display name, and work email if available). It supports bounded pagination/search and admin authorization. No vendor employee is included merely because of a vendor relationship.

Expense Warrior continues to own manager assignments. Manager candidates come from the enrolled ITC directory, and the existing rule that a manager must be an Expense Warrior member is enforced. Membership role does not itself grant manager scope. Payout destinations, requests, approvals, receipts, and audit trails stay in the Expense Warrior database.

## API and migration shape

ITC needs an additive migration for the membership table and indexes, an admin-only membership management API/UI, an authenticated Expense Warrior-specific login/session contract, and a directory endpoint backed by active memberships. The exact route names and migration number remain implementation choices, coordinated with ITC release ownership.

Expense Warrior changes are limited to consuming the app-specific session field, rejecting absent/inactive membership, and updating the team directory contract as required. No direct database connection from Expense Warrior to ITC is allowed.

The migration is to be authored and reviewed only after this design is approved. It must not be applied or adopted without a separate owner-approved target and operation. Rollback should disable the new API/contract first and preserve membership/audit rows; dropping the table is not an automatic rollback.

## Tests and acceptance criteria

- Enrolled ITC `customer` and `vendor` can establish the Expense Warrior session, receive their app role, and still cannot access general Shop.IT backoffice routes.
- An unenrolled user, inactive membership, or membership lookup failure is denied by Expense Warrior.
- Changing/revoking membership is reflected on the next ITC session resolution and Expense Warrior authorization check.
- Global ITC `admin`/`staff` status without an Expense Warrior membership does not implicitly grant Expense Warrior access.
- Only ITC global administrators can grant/change/revoke membership; audit rows identify actor, subject, action, and prior/new state.
- Directory results contain only active members, enforce bounded pagination, and expose no unnecessary personal or vendor data.
- Existing ITC login/session behavior for storefront and Shop.IT remains compatible.
- Expense Warrior unit and contract tests cover app role mapping, missing role, invalid role, and revoked membership; ITC tests cover login audience separation, role isolation, management authorization, audit, and directory filtering.

## Security and operational risks

- **Privilege escalation:** highest risk is accidentally treating `expense_warrior_role` as global ITC `role`; tests must prove route isolation.
- **Revocation latency:** bounded by the ITC session-check path; avoid trusting a long-lived role copied only into a JWT.
- **Cross-repo rollout:** deploy ITC compatibility first (app role response and endpoint), then Expense Warrior consumer. Until both are ready, keep Expense Warrior access closed for accounts without the explicit field.
- **Admin bootstrap:** only an already trusted ITC administrator can enroll the first Expense Warrior admin; document and audit that step.
- **Availability:** ITC membership lookup failure denies access rather than falling back to global role.

## Decisions

- Reuse ITC identity, password/2FA services, and session machinery: **yes**.
- Dedicated `expense_warrior` audience and access/refresh cookies: **proposed; owner approval pending**.
- Membership onboarding: **enroll existing active ITC accounts; account creation/invitation stays in ITC's existing provisioning flow**.
- Keep Shop.IT global role unchanged: **yes**.
- Store Expense Warrior membership in ITC: **yes**.
- V1 membership scope: **single company**.
- V1 app roles: **admin** and **staff**.
- Membership management: **existing ITC global administrators only**.
- Manager assignments: **remain in Expense Warrior**.

## Remaining implementation choices

- ITC endpoint and route names.
- Whether the owner approves the dedicated `expense_warrior` session audience/cookie boundary.
- Whether the existing sign-in screen safely supports that audience or needs a small ITC-owned login entry point backed by the same auth/session service.
- Exact database field names, indexes, and migration number.
- ITC admin UI placement and audit event naming.
