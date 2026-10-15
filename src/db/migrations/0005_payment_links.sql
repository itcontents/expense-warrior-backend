CREATE TABLE payment_links (
  payment_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'ZMW' CHECK (currency = 'ZMW'),
  description varchar(240) NOT NULL CHECK (length(btrim(description)) > 0),
  public_token_hash char(64) NOT NULL UNIQUE CHECK (public_token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_by_customer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  disabled_by_customer_id uuid,
  disabled_at timestamptz,
  CHECK ((status = 'ACTIVE' AND disabled_at IS NULL AND disabled_by_customer_id IS NULL) OR
         (status = 'DISABLED' AND disabled_at IS NOT NULL AND disabled_by_customer_id IS NOT NULL))
);

CREATE INDEX payment_links_created_idx ON payment_links (created_at DESC, payment_link_id DESC);
CREATE INDEX payment_links_active_idx ON payment_links (payment_link_id) WHERE status = 'ACTIVE';

CREATE TABLE payment_link_creation_requests (
  actor_customer_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  payment_link_id uuid NOT NULL REFERENCES payment_links(payment_link_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (actor_customer_id, idempotency_key),
  UNIQUE (payment_link_id)
);

CREATE TABLE payment_link_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_link_id uuid NOT NULL REFERENCES payment_links(payment_link_id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_code varchar(32) NOT NULL CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_transaction_id uuid NOT NULL UNIQUE,
  network_code varchar(32) NOT NULL CHECK (network_code IN ('AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB')),
  payer_phone varchar(15) NOT NULL CHECK (payer_phone ~ '^[0-9]{7,15}$'),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency = 'ZMW'),
  state text NOT NULL CHECK (state IN ('SUBMITTING', 'PENDING', 'UNKNOWN', 'FAILED', 'VERIFIED_PENDING_LEDGER', 'SUCCEEDED')),
  provider_status varchar(40),
  provider_reference varchar(128),
  verified_at timestamptz,
  ledger_operation_id uuid,
  last_error_code varchar(100) CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (payment_link_id, idempotency_key),
  CHECK ((state IN ('VERIFIED_PENDING_LEDGER', 'SUCCEEDED') AND verified_at IS NOT NULL) OR
         (state NOT IN ('VERIFIED_PENDING_LEDGER', 'SUCCEEDED') AND verified_at IS NULL)),
  CHECK ((state = 'SUCCEEDED' AND ledger_operation_id IS NOT NULL) OR
         (state <> 'SUCCEEDED' AND ledger_operation_id IS NULL))
);

CREATE INDEX payment_link_attempts_link_created_idx
  ON payment_link_attempts (payment_link_id, created_at DESC, attempt_id DESC);
CREATE INDEX payment_link_attempts_recovery_idx
  ON payment_link_attempts (state, updated_at, attempt_id)
  WHERE state IN ('SUBMITTING', 'UNKNOWN', 'VERIFIED_PENDING_LEDGER');
