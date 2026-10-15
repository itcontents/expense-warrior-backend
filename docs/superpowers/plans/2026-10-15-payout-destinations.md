# Staff Payout Destinations Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let admins assign each eligible ITC staff member a Zambia mobile-money destination and snapshot its encrypted phone and network onto each new request.

**Architecture:** Expense Warrior owns versioned destination history; ITC remains the identity source. Store phone values encrypted with a versioned AES-256-GCM keyring and store a keyed fingerprint for idempotent update detection. A request transaction locks and snapshots the current destination so later edits cannot redirect an in-flight payout.

**Tech Stack:** Node 20, Express 5, PostgreSQL, Vue 3, AES-256-GCM, ITC signed-in session identity API.

**Spec:** `back/PLAN.md` (staff payout destinations and request snapshots), `front/PLAN.md` (admin team and request flows).

## Global Constraints

- Only admins can change or list staff destinations; staff can read only their own masked destination.
- Eligible staff identities must be verified through ITC's active staff directory API.
- Accept Zambia E.164 `260` numbers and local `0` numbers, then normalize to `260#########`.
- Provider codes are `AIRTEL_OAPI_ZMB`, `MTN_MOMO_ZMB`, and `ZAMTEL_ZMB`.
- Never persist or return the full phone number in plaintext; never include it in audit metadata or logs.
- Requests snapshot destination ID, network, ciphertext, key ID, and last four digits transactionally.
- Migration `0007` remains source-only and must not be applied.

## Review Focus

- Missing, malformed, or short encryption keys fail closed before destination writes.
- Ineligible or inactive ITC identities cannot receive a destination.
- Concurrent destination replacement and request submission cannot change the request's selected number.
- Replaying the same network and phone is idempotent and does not create duplicate audit history.
- Staff IDs and phone values cannot be used to read another staff member's destination.

---

### Task 1: Encrypted destination model and admin API

**Files:**
- Create: `back/src/payoutDestinations/phoneVault.js`
- Create: `back/src/payoutDestinations/payoutDestinationRepository.js`
- Create: `back/src/payoutDestinations/payoutDestinationService.js`
- Create: `back/src/payoutDestinations/payoutDestinationRoutes.js`
- Create: `back/src/db/migrations/0007_staff_payout_destinations.sql` (source only)
- Create: focused tests for crypto, repository, service, and routes
- Modify: `back/src/config/env.js`, `back/src/app.js`, `.env.example`

**Interfaces:**
- `createPhoneVault({ keysJson, activeKeyId })` exposes `encrypt({ staffId, phone })`, `decrypt({ staffId, keyId, ciphertext })`, and `fingerprint({ staffId, phone })`.
- `PUT /api/v1/expense-warrior/admin/payout-destinations/:staff_id` accepts `{ network_code, phone_number }` and returns masked destination metadata.
- `GET /api/v1/expense-warrior/admin/payout-destinations` returns active destination metadata only.
- `GET /api/v1/expense-warrior/payout-destination/me` returns the verified actor's masked destination.

- [x] Test phone normalization, encryption/decryption, key rotation, malformed-key failure, admin role checks, and audit metadata redaction.
- [x] Test transaction advisory-lock use and audit redaction; repository also returns unchanged when existing network/fingerprint match.

### Task 2: Immutable request snapshot

**Files:**
- Modify: `back/src/requests/requestRepository.js`
- Modify: `back/tests/requestRepository.test.js`
- Modify: request response mapping tests if needed

- [x] Test a valid destination is snapshotted with network, cipher, key ID, and last four digits.
- [x] Test missing-destination rejection and exact request replay returning the original saved response without re-reading the current destination.
- [x] Run `cd back && npm test`.

### Task 3: Mobile admin destination controls

**Files:**
- Modify: `front/src/api/expenseWarrior.js`
- Modify: `front/src/views/WorkspaceView.vue`
- Modify: `front/src/styles.css`
- Modify: `front/PLAN.md`

- [x] Add destination assignment/list controls to the admin Team page and show each employee the masked destination on the request form.
- [x] Run frontend tests and build. Authenticated browser coverage and a mobile layout pass remain outstanding.
