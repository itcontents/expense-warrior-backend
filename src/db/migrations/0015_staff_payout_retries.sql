-- Source-only: apply only through a separately approved migration rollout.
-- Keep every provider attempt and its reservation identity when a request retries.
ALTER TABLE request_payout_attempts
  DROP CONSTRAINT request_payout_attempts_request_id_key,
  ADD COLUMN reservation_operation_id uuid UNIQUE,
  ADD COLUMN reservation_idempotency_key varchar(128) UNIQUE,
  ADD COLUMN reservation_hold_id uuid UNIQUE,
  ADD COLUMN reservation_state text;

-- The request still points at the original reservation before retries are enabled.
-- Provider/account, routing, amount, currency, and client references are untouched.
UPDATE request_payout_attempts AS payout
   SET reservation_operation_id = request.finance_operation_id,
       reservation_idempotency_key = request.finance_idempotency_key,
       reservation_hold_id = request.finance_hold_id,
       reservation_state = request.finance_reservation_state
  FROM expense_requests AS request
 WHERE payout.request_id = request.request_id;

ALTER TABLE request_payout_attempts
  ADD CONSTRAINT request_payout_attempts_reservation_state_check CHECK (
    reservation_state IS NULL OR reservation_state IN ('PENDING','RESERVED','CONSUMED','RELEASED','FAILED','UNKNOWN')
  ),
  ADD CONSTRAINT request_payout_attempts_reservation_key_check CHECK (
    reservation_idempotency_key IS NULL OR length(btrim(reservation_idempotency_key)) BETWEEN 8 AND 128
  ),
  -- Permit an entirely absent snapshot for compatibility with the original writer.
  -- A populated snapshot must include the operation/key and the appropriate hold.
  ADD CONSTRAINT request_payout_attempts_reservation_identity_check CHECK (
    (reservation_state IS NULL AND reservation_operation_id IS NULL
      AND reservation_idempotency_key IS NULL AND reservation_hold_id IS NULL)
    OR (reservation_state IS NOT NULL AND reservation_operation_id IS NOT NULL
      AND reservation_idempotency_key IS NOT NULL AND (
        (reservation_state IN ('PENDING','UNKNOWN','FAILED') AND reservation_hold_id IS NULL)
        OR (reservation_state IN ('RESERVED','CONSUMED','RELEASED') AND reservation_hold_id IS NOT NULL)
      ))
  ),
  DROP CONSTRAINT request_payout_attempts_state_check,
  ADD CONSTRAINT request_payout_attempts_state_check CHECK (state IN (
    'RESERVING','SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED',
    'FAILED_PENDING_RELEASE','FAILED','PAID','RESERVATION_FAILED'
  )),
  ADD CONSTRAINT request_payout_attempts_reserving_check CHECK (
    state <> 'RESERVING' OR (reservation_state IS NOT NULL AND reservation_state IN ('PENDING','UNKNOWN'))
  ),
  ADD CONSTRAINT request_payout_attempts_reservation_failed_check CHECK (
    state <> 'RESERVATION_FAILED' OR (reservation_state IS NOT NULL AND reservation_state = 'FAILED')
  );

CREATE UNIQUE INDEX request_payout_attempts_one_active_idx
  ON request_payout_attempts (request_id)
  WHERE state IN ('RESERVING','SUBMITTING','PENDING','UNKNOWN','VERIFICATION_REQUIRED','FAILED_PENDING_RELEASE');

CREATE INDEX request_payout_attempts_latest_idx
  ON request_payout_attempts (request_id, created_at DESC, payout_id DESC);
