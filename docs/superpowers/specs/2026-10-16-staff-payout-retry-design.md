# Staff payout retry design

**Status:** product policy and append-only attempt model approved by the owner; detailed implementation spec ready for review.

## Purpose

Allow an administrator to retry a failed staff payout on the same expense request without losing the original payout or hold history. A retry is allowed only after PawaPay confirms a terminal failure and ITC confirms that the original hold was released. Every retry must obtain a new ITC reservation before sending a new PawaPay payout.

Pending, unknown, verification-required, or unreleased payouts remain locked for reconciliation. Retrying or refreshing an unresolved attempt must never create a replacement provider transaction or a second hold.

## Current constraints

- `request_payout_attempts.request_id` is unique, so only one payout attempt can be stored per request.
- The ITC reservation identity and hold are currently stored on `expense_requests`. A retry would overwrite the only local reference to the original hold unless each payout attempt snapshots its own reservation identity.
- The current admin recovery view shows unresolved payouts but has no action for a terminally failed, released payout.
- The latest Expense Warrior migration is `0014_provider_addon_lifecycle.sql`; this work will author `0015_staff_payout_retries.sql` and will not apply it.

## Chosen architecture

Keep the request and its original approval decisions as the durable workflow record. Append one payout-attempt row for each provider transaction. Attempt identities and routing/accounting snapshots do not change after insertion; only lifecycle and reconciliation fields advance.

Each attempt stores its own ITC reservation operation ID, idempotency key, hold ID, and reservation state. Existing attempts are backfilled from their current request-level reservation. The request-level finance fields continue to describe the current attempt for existing UI and workflow consumers; the attempt row preserves the historical reservation when those request fields move to a later attempt.

Migration `0015` will remove the one-row-per-request constraint, add a partial unique index that permits at most one active attempt per request, add reservation fields and checks, backfill existing rows, and add an index for finding the latest attempt. Terminal `FAILED`, `RESERVATION_FAILED`, and `PAID` rows remain in history and do not block a later eligible retry.

Attempt states add `RESERVING` and `RESERVATION_FAILED` to the existing payout lifecycle. `RESERVING` means an ITC hold operation is underway or has an unknown result; no PawaPay call is allowed in that state. A confirmed reservation moves the attempt to `SUBMITTING`. A definitive ITC reservation failure moves the attempt to `RESERVATION_FAILED`, returns the request to `PAYOUT_FAILED`, and records an audit event. A retry after that failure may create another attempt because the prior provider payout is already terminally failed and released.

## Retry flow

1. The admin opens an eligible failed payout, reviews the saved destination and amount, and explicitly confirms **Retry payout**.
2. `POST /api/v1/expense-warrior/admin/requests/:request_id/payout/retry` verifies the admin role and locks the request and latest attempt.
3. The repository permits a new attempt only when the previous provider attempt is `FAILED`, its ITC release state is `RELEASED`, the request is `PAYOUT_FAILED`, and there is no active attempt. A retry of an existing `RESERVING` attempt resumes that same attempt instead of inserting another.
4. The transaction persists a fresh payout ID, payout-attempt ID, provider client reference, ITC reserve operation ID, and idempotency key. It snapshots the original provider account, network, amount, currency, destination binding, and expense-category mapping. It marks the request `PAYOUT_PENDING` while reservation is unresolved and appends audit evidence. It does not add another admin approval decision.
5. The service calls the signed ITC reserve API with the stored operation/idempotency identity. An unknown result keeps the attempt in `RESERVING`; a later explicit retry uses the exact same operation and cannot call PawaPay until ITC returns a matching active hold.
6. After confirming the hold identity, amount, currency, provider/account version, and expense mapping, the service stores the hold on the attempt and request, then submits one payout using the new provider transaction ID and client reference.
7. Existing provider reconciliation rules apply to this attempt. Verified success consumes this attempt's hold. Verified terminal provider failure releases this attempt's hold. Unknown or mismatched evidence remains locked. A new retry is available only after the release is confirmed.

## API and UI

- Add an admin-only retry route; do not reuse final approval or bulk approval. The existing decision row remains the original admin approval, and retries create audit events rather than duplicate approvals.
- The recovery query returns only the latest attempt per request. It includes unresolved attempts and terminal failed attempts whose hold is confirmed released. Older failed attempts remain queryable in durable history/audit but do not create duplicate recovery cards.
- The mobile admin recovery panel offers **Retry payout** only for the eligible terminal state, and **Resume reservation** for `RESERVING`. Other unresolved states continue to offer status reconciliation only. Retry confirmation shows the amount, saved mobile-money network, and the destination revealed through the existing audited endpoint.
- The request list uses the latest attempt for status/error display so multiple attempts do not duplicate requests.
- The retry response uses the existing pending/result shape. Errors distinguish ineligible state, pending reconciliation, and finance-service failure without exposing provider free text.

## Authorization, concurrency, and accounting safety

- The service checks an active authenticated admin; the request owner cannot approve or retry their own request.
- The request row lock serializes retry creation. The partial unique active-attempt index is the database backstop against concurrent attempts.
- A new stable ITC reservation operation is persisted before the network call. Retries after timeout replay that same operation. Provider initiation uses one persisted new PawaPay transaction ID and is never automatically retried with a different ID after an ambiguous outcome.
- Consume and release operate against the hold snapshot on the selected payout attempt, not whichever hold happens to be current on the request row.
- Provider account, network, destination, amount, currency, and ITC expense category are copied from the approved request/previous attempt and cannot be supplied or changed by the browser.
- Attempt lifecycle changes and request status changes are transactional and audited. No attempt row is deleted or replaced.

## Validation

Add service, route, repository, migration-guard, and temporary-PostgreSQL tests for:

- admin-only retry after verified terminal failure and confirmed hold release;
- fresh payout, attempt, reservation, and provider identities while preserving the prior attempt and approval decisions;
- concurrent duplicate retry requests producing one active attempt and one ITC operation;
- pending, unknown, verification-required, failed-pending-release, paid, or unconfirmed-release attempts never producing another payout;
- unknown reservation replay using the same operation/idempotency identity and never submitting before a matching active hold;
- definitive reservation failure without a provider call, followed by a permitted later retry;
- per-attempt hold usage for consume/release and request-list queries selecting only the latest attempt;
- admin UI retry/resume/reconcile actions and confirmation details at mobile viewport sizes.

Run the backend unit suite, gated PostgreSQL suite against session-local temporary tables, frontend suite/build, and a mocked browser flow. Do not apply migrations, create an ITC hold, or contact PawaPay as part of implementation validation.

## Alternatives considered

1. **Append payout attempts (chosen):** preserves immutable provider and hold history, supports a database-enforced single active attempt, and is directly reportable. It needs an additive migration and coordinated repository/UI work.
2. **Reuse the existing row:** smaller change but overwrites provider transaction and hold identities, weakening audit, reconciliation, and financial history. Rejected.
3. **Add a separate retry table:** preserves history but splits attempt state across two sources and complicates locking, reports, and recovery. Rejected.

## Release boundary

This feature remains disabled with the existing payout feature gate. The migration is source-only until separately authorized. Live ITC/PawaPay behavior, merchant readiness, and the target database migration ledger remain release checks; source tests do not prove those external states.
