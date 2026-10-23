# PawaPay sandbox readiness check — 16 October 2026

## Scope and safety

This check used the Expense Warrior PawaPay client and the configured sandbox URL only. It sent two signed, read-only requests: `GET /v2/active-conf?country=ZMB&operationType=DEPOSIT` and `GET /v2/wallet-balances?country=ZMB`. It did not call phone prediction, deposits, payouts, refunds, or callbacks. No payment or financial posting was initiated, and no secret values were recorded here.

PawaPay's official materials describe sandbox as an isolated test environment and publish the Merchant API Active Configuration and Wallet Balances endpoints. The configured base URL was `https://api.sandbox.pawapay.io`; this result says nothing about production merchant configuration. See [PawaPay sandbox setup](https://www.pawapay.io/getting-started-guide-ai), [sandbox Merchant API collection](https://www.postman.com/pawapay-4106/pawapay/collection/sq6fhos/pawapay-merchant-api-test), [Active Configuration request](https://www.postman.com/pawapay-4106/pawapay/request/02smqd5/active-configuration), and [Wallet Balances API](https://docs.pawapay.io/v2/api-reference/finances/wallet-balances).

## Sanitized local configuration check

- API token: configured (value deliberately not shown).
- Request signing: enabled; signing key ID configured; private key file exists with mode `0600`.
- Account-level signed-requests-only confirmation: `true` in local configuration. This is an owner-provided confirmation, not independent proof from the PawaPay dashboard.
- Collection and payout initiation flags: both `false`.

## Sandbox active deposit configuration

The signed read returned these usable `ZMB` / `ZMW` deposit choices. The adapter exposes only operational entries that advertise `PROVIDER_AUTH` with `AUTOMATIC` prompt mode, which is the phone-prompt flow supported by the current payer page.

| Network | Provider code | Status in adapter | Amount range | Decimals | Authorization |
|---|---|---|---:|---|---|
| Airtel Money | `AIRTEL_OAPI_ZMB` | Operational | ZMW 1–20,000 | Two decimal places | Provider prompt, automatic |
| MTN MoMo | `MTN_MOMO_ZMB` | Operational | ZMW 1–20,000 | Two decimal places | Provider prompt, automatic |
| Zamtel Kwacha | `ZAMTEL_ZMB` | Operational | ZMW 1–20,000 | Two decimal places | Provider prompt, automatic |

## Sandbox wallet balance read

The signed wallet-balance request succeeded and returned one record for `ZMB` / `ZMW`; the provider field was empty and the balance field was a string. The exact amount is intentionally not stored in this document. The Expense Warrior wallet view labels an empty provider as the aggregate “PawaPay wallet,” not as a per-network balance. This sandbox result is not an ITC ledger balance or a production balance.

## Remaining checks

These reads do not verify payout configuration, settlement, provider status/recovery behavior, signed-request enforcement at the account, or live phone prompt UX. The official sandbox guide says the real PIN/authorization prompt is not shown in sandbox; do not represent sandbox status testing as proof of that user experience. Keep payment initiation flags disabled until the ITC migration/accounting gates and all merchant-account checks are complete. Any sandbox transaction test requires its own explicit authorization and must use the documented sandbox test MSISDNs.

## Current local configuration gate — 22 October 2026

The local Expense Warrior `.env` now binds sandbox PawaPay account `b381e6e4-c2f2-49d5-bd93-0d777814954e`, version 3. An authenticated ITC configuration read found it `READY`, accepting new `MOBILE_MONEY` / `ZMW` / `ZM` payments, and mapped to the active PawaPay clearing Treasury account. The owner confirmed signed-only enforcement is enabled for this sandbox account. The local HMAC service credentials match ITC's service-key map. Collection, payout, and callback-inbox initiation flags remain false; ITC finance and payment workers remain disabled. The local API's `/api/v1/ready` returns HTTP 200, which is process/dependency readiness and does not prove signed financial readiness.

The remaining local gate is the signed readiness call: ITC's HMAC middleware claims a durable replay nonce even for this readiness request, so no request was made without an authorized operation-specific path. No deposit, payout, refund, collection, or ledger posting was attempted. Production account readiness is separate and remains unverified. The local `PAWAPAY_SIGNED_REQUESTS_ONLY_CONFIRMED=true` value remains an assertion; the owner confirmation above is the evidence available for the sandbox account.
