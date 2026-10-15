ALTER TABLE expense_requests
  ADD COLUMN finance_operation_id uuid UNIQUE,
  ADD COLUMN finance_idempotency_key varchar(128) UNIQUE,
  ADD COLUMN finance_hold_id uuid UNIQUE,
  ADD COLUMN finance_reservation_state text,
  ADD COLUMN finance_error_code varchar(100),
  ADD CONSTRAINT expense_requests_finance_state_chk
    CHECK (finance_reservation_state IS NULL OR finance_reservation_state IN ('PENDING','RESERVED','FAILED','UNKNOWN')),
  ADD CONSTRAINT expense_requests_finance_identity_chk
    CHECK (
      (finance_reservation_state IS NULL AND finance_operation_id IS NULL AND finance_idempotency_key IS NULL AND finance_hold_id IS NULL AND finance_error_code IS NULL)
      OR (finance_reservation_state IN ('PENDING','FAILED','UNKNOWN') AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NULL)
      OR (finance_reservation_state = 'RESERVED' AND finance_operation_id IS NOT NULL AND finance_idempotency_key IS NOT NULL AND finance_hold_id IS NOT NULL AND finance_error_code IS NULL)
    ),
  ADD CONSTRAINT expense_requests_finance_idempotency_key_chk
    CHECK (finance_idempotency_key IS NULL OR length(trim(finance_idempotency_key)) BETWEEN 8 AND 128),
  ADD CONSTRAINT expense_requests_finance_error_code_chk
    CHECK (finance_error_code IS NULL OR finance_error_code ~ '^[A-Z0-9_]{1,100}$');

CREATE INDEX expense_requests_finance_pending_idx
  ON expense_requests (finance_reservation_state, updated_at, request_id)
  WHERE status = 'MANAGER_APPROVAL_PENDING_HOLD';
