ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_finance_state_chk,
  ADD CONSTRAINT expense_requests_finance_state_chk
    CHECK (finance_reservation_state IS NULL OR finance_reservation_state IN ('PENDING','RESERVED','RELEASED','FAILED','UNKNOWN')),
  DROP CONSTRAINT expense_requests_finance_identity_chk,
  ADD CONSTRAINT expense_requests_finance_identity_chk
    CHECK (
      (finance_reservation_state IS NULL AND finance_operation_id IS NULL AND finance_idempotency_key IS NULL AND finance_hold_id IS NULL AND finance_error_code IS NULL)
      OR (finance_reservation_state IN ('PENDING','FAILED','UNKNOWN') AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NULL)
      OR (finance_reservation_state IN ('RESERVED','RELEASED') AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NOT NULL)
    ),
  ADD COLUMN finance_release_operation_id uuid UNIQUE,
  ADD COLUMN finance_release_idempotency_key varchar(128) UNIQUE,
  ADD COLUMN finance_release_state text,
  ADD COLUMN finance_release_actor_customer_id uuid,
  ADD COLUMN finance_release_reason text,
  ADD COLUMN finance_release_error_code varchar(100),
  ADD CONSTRAINT expense_requests_finance_release_state_chk
    CHECK (finance_release_state IS NULL OR finance_release_state IN ('PENDING','RELEASED','UNKNOWN')),
  ADD CONSTRAINT expense_requests_finance_release_identity_chk
    CHECK (
      (finance_release_state IS NULL AND finance_release_operation_id IS NULL AND finance_release_idempotency_key IS NULL AND finance_release_actor_customer_id IS NULL AND finance_release_reason IS NULL AND finance_release_error_code IS NULL)
      OR (finance_release_state IN ('PENDING','UNKNOWN') AND finance_release_operation_id IS NOT NULL AND finance_release_idempotency_key IS NOT NULL AND finance_release_actor_customer_id IS NOT NULL AND finance_release_reason IS NOT NULL)
      OR (finance_release_state = 'RELEASED' AND finance_release_operation_id IS NOT NULL AND finance_release_idempotency_key IS NOT NULL AND finance_release_actor_customer_id IS NOT NULL AND finance_release_reason IS NOT NULL AND finance_release_error_code IS NULL)
    ),
  ADD CONSTRAINT expense_requests_finance_release_error_chk
    CHECK (finance_release_error_code IS NULL OR finance_release_error_code ~ '^[A-Z0-9_]{1,100}$'),
  ADD CONSTRAINT expense_requests_finance_release_reason_chk
    CHECK (finance_release_reason IS NULL OR length(trim(finance_release_reason)) BETWEEN 1 AND 2000);

CREATE INDEX expense_requests_finance_release_pending_idx
  ON expense_requests (finance_release_state, updated_at, request_id)
  WHERE finance_release_state IN ('PENDING','UNKNOWN');
