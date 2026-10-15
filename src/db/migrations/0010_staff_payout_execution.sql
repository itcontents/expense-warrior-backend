ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_status_check,
  ADD CONSTRAINT expense_requests_status_check CHECK (status IN (
    'PENDING_MANAGER',
    'MANAGER_APPROVAL_PENDING_HOLD',
    'MANAGER_APPROVED',
    'PENDING_ADMIN',
    'APPROVED_AWAITING_PAYOUT',
    'PAYOUT_PENDING',
    'PAID',
    'PAYOUT_FAILED',
    'REJECTED_MANAGER',
    'REJECTED_ADMIN'
  )),
  DROP CONSTRAINT expense_requests_finance_state_chk,
  ADD CONSTRAINT expense_requests_finance_state_chk
    CHECK (finance_reservation_state IS NULL OR finance_reservation_state IN ('PENDING','RESERVED','CONSUMED','RELEASED','FAILED','UNKNOWN')),
  DROP CONSTRAINT expense_requests_finance_identity_chk,
  ADD CONSTRAINT expense_requests_finance_identity_chk CHECK (
    (finance_reservation_state IS NULL AND finance_operation_id IS NULL AND finance_idempotency_key IS NULL AND finance_hold_id IS NULL AND finance_error_code IS NULL)
    OR (finance_reservation_state IN ('PENDING','FAILED','UNKNOWN') AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NULL)
    OR (finance_reservation_state IN ('RESERVED','CONSUMED','RELEASED') AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NOT NULL)
  );

CREATE TABLE request_payout_attempts (
  payout_id uuid PRIMARY KEY,
  payout_attempt_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE REFERENCES expense_requests(request_id) ON DELETE RESTRICT,
  provider_code varchar(32) NOT NULL CHECK (provider_code = 'pawapay'),
  network_code varchar(32) NOT NULL CHECK (network_code IN ('AIRTEL_OAPI_ZMB','MTN_MOMO_ZMB','ZAMTEL_ZMB')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency = 'ZMW'),
  client_reference_id varchar(128) NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE','FAILED','PAID')),
  provider_status varchar(80),
  provider_transaction_reference varchar(128),
  error_code varchar(100) CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$'),
  consume_operation_id uuid NOT NULL UNIQUE,
  consume_state text NOT NULL DEFAULT 'PENDING' CHECK (consume_state IN ('PENDING','UNKNOWN','CONSUMED')),
  release_operation_id uuid UNIQUE,
  release_idempotency_key varchar(128) UNIQUE,
  release_state text CHECK (release_state IS NULL OR release_state IN ('PENDING','UNKNOWN','RELEASED')),
  release_error_code varchar(100) CHECK (release_error_code IS NULL OR release_error_code ~ '^[A-Z0-9_]{1,100}$'),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ((release_operation_id IS NULL) = (release_idempotency_key IS NULL)),
  CHECK (state <> 'PAID' OR (consume_state = 'CONSUMED' AND verified_at IS NOT NULL)),
  CHECK (state <> 'FAILED' OR release_state = 'RELEASED')
);

CREATE INDEX request_payout_attempts_recovery_idx
  ON request_payout_attempts (state, updated_at, payout_id)
  WHERE state IN ('SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE');

CREATE INDEX request_payout_attempts_created_idx
  ON request_payout_attempts (created_at DESC, payout_id DESC);
