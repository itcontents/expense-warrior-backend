# Adding a payment provider

Expense Warrior owns its provider integrations in `back/src/providers/`. V1 uses PawaPay. A later provider is added as a statically registered adapter; request, link, and accounting workflows continue to call the normalized provider contract.

## Provider ownership boundary

An adapter owns provider credentials, signed HTTP calls, provider-specific request and response shapes, authoritative status reads, callback verification, active capability lookup, and mapping provider results into Expense Warrior's normalized contract. ITC remains the authority for holds and ledger posting. The adapter must not post financial records itself or treat a callback, redirect, or provider initiation response as confirmed payment success.

The browser sends only `provider_code`, `network_code`, and the payer's phone number. It never receives provider credentials, signing keys, or raw provider payloads. The backend validates the selected provider and network against that provider's current active account configuration before creating an attempt.

## Registration steps

1. Add the provider client and adapter under `src/providers/<provider>/`.
2. Add a registrar under `src/providers/` and register it in `src/providers/providerAddons.js`. Registration is static and reviewed; do not load executable add-ons from the database or the filesystem at runtime.
3. Add validated provider configuration to `src/config/env.js`. Keep all credentials server-side and fail startup or the requested operation closed when required signing configuration is incomplete.
4. Return the adapter definition map from the registrar. Each definition has a unique lowercase provider code, `contractVersion: 1`, `create()`, `getNetworks(operation)`, and an account identity. Add `getActiveNetworks(operation, options)` for account-enabled public choices. Add `createForAccount(identity)` when old attempts must continue using a pinned account configuration after configuration changes.
5. Keep `provider_code` alongside `network_code` in attempt identity, idempotency fingerprints, audit records, callback routing, and reports. The registry owns `provider_code` and overwrites any adapter-supplied value. The same network code can exist under multiple providers.
6. Add mocked contract tests and database tests for the provider's supported operations. Do not enable its financial flags or call a provider until its account-specific configuration and signing requirements have been verified.

## Normalized adapter contract

Every returned client has `contractVersion: 1`. `getForOperation(providerCode, operation, accountIdentity)` checks that the requested operation is implemented. The adapter reports only the operations it supports.

| Operation | Required adapter methods |
| --- | --- |
| `deposit` | `initiateDeposit`, `getDepositStatus` |
| `payout` | `initiatePayout`, `getPayoutStatus` |
| `refund` | `initiateRefund`, `getRefundStatus` |
| `balance` | `getWalletBalances` |
| `callback` | `verifyCallback`, `normalizeCallback` |

Deposit and payout initiation return a normalized result with `transaction_id`, `outcome`, `provider_status`, optional bounded `rejection_code`, and evidence fields for country, amount, currency, network, phone, client reference, and provider transaction ID. Initiation outcomes are `ACCEPTED`, `DUPLICATE`, `REJECTED`, or `UNKNOWN`. Status outcomes are `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `NOT_FOUND`, or `UNKNOWN`. Unknown outcomes must remain recoverable and must never trigger an automatic replacement financial request.

Active deposit options include `provider_code`, `code`, `label`, amount limits, currency and amount precision, and authorization requirements. The public payment page exposes only active options that meet the V1 payment flow's supported authorization requirements. Each payout destination and each in-flight attempt retains the provider account ID and version used when it was created.

## Security and failure rules

- Sign every financial provider request with the provider's required scheme. A configured API token alone does not prove signed-only account enforcement.
- Use bounded timeouts and response sizes. Do not automatically retry an ambiguous financial POST with a new transaction identity.
- Verify authoritative status and match the original provider account, transaction ID, amount, currency, network, destination, and merchant reference before asking ITC to post.
- Verify callbacks against the exact raw request representation. Persist only minimal, redacted callback hints and deduplicate them before status reconciliation.
- Return safe normalized error codes. Do not persist provider free text, secrets, PINs, or unnecessary phone data.
- Keep provider balances separate from ITC ledger balances, holds, and available amounts.

## Required adapter checks

- Test valid and invalid signing configuration without making a provider call.
- Test every supported operation's accepted, pending, success, failure, cancelled, malformed, timeout, and unknown responses.
- Test that duplicate and ambiguous initiation results cannot create a second provider transaction.
- Test that an account version change does not make an old attempt use the new account credentials.
- Test active-network filtering for country, currency, operation, transaction limits, precision, and authorization behavior.
- Test callback signature failure, replay, duplicate delivery, malformed raw payload, and status reconciliation.
- Test same `network_code` offered by two providers and prove the selected `provider_code` remains bound to the attempt.
- Test ledger posting remains idempotent and happens only after the application service verifies the provider evidence.

The current registry and contract tests live in `src/providers/providerRegistry.js`, `src/providers/providerAddons.js`, and `tests/providerRegistry.test.js`. PawaPay-specific signing and mapping tests live in `tests/pawaPayAdapter.test.js`.
