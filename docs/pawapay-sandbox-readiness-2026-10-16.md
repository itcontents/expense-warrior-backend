# PawaPay sandbox readiness check — 16 October 2026

## Scope and safety

This check used the Expense Warrior PawaPay client and the configured sandbox URL only. It sent one signed, read-only `GET /v2/active-conf?country=ZMB&operationType=DEPOSIT`. It did not call wallet balances, phone prediction, deposits, payouts, refunds, or callbacks. No payment or financial posting was initiated, and no secret values were recorded here.

PawaPay's official materials describe sandbox as an isolated test environment and publish the Merchant API toolkit's Active Configuration request. The configured base URL was `https://api.sandbox.pawapay.io`; this result says nothing about production merchant configuration. See [PawaPay sandbox setup](https://www.pawapay.io/getting-started-guide-ai), [sandbox Merchant API collection](https://www.postman.com/pawapay-4106/pawapay/collection/sq6fhos/pawapay-merchant-api-test), and [Active Configuration request](https://www.postman.com/pawapay-4106/pawapay/request/02smqd5/active-configuration).

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

## Remaining checks

This read does not verify payout configuration, wallet balances, settlement, provider status/recovery behavior, signed-request enforcement at the account, or live phone prompt UX. The official sandbox guide says the real PIN/authorization prompt is not shown in sandbox; do not represent sandbox status testing as proof of that user experience. Keep payment initiation flags disabled until the ITC migration/accounting gates and all merchant-account checks are complete. Any sandbox transaction test requires its own explicit authorization and must use the documented sandbox test MSISDNs.
