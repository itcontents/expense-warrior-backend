ALTER TABLE payment_link_attempts
  ADD COLUMN receivable_reservation_id uuid,
  ADD COLUMN receivable_reservation_state text,
  ADD CONSTRAINT payment_link_attempts_receivable_reservation_state_check
    CHECK (receivable_reservation_state IS NULL OR receivable_reservation_state IN ('PENDING', 'UNKNOWN', 'ACTIVE', 'RELEASED', 'APPLIED')),
  ADD CONSTRAINT payment_link_attempts_receivable_reservation_pair_check
    CHECK ((receivable_reservation_id IS NULL AND receivable_reservation_state IS NULL) OR
           (receivable_reservation_id IS NOT NULL AND receivable_reservation_state IS NOT NULL));

CREATE TABLE payment_link_receivable_closures (
  payment_link_id uuid PRIMARY KEY REFERENCES payment_links(payment_link_id) ON DELETE RESTRICT,
  receivable_id uuid NOT NULL,
  collection_operation_id uuid NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (payment_link_id, receivable_id, collection_operation_id)
);

REVOKE ALL ON payment_link_receivable_closures FROM PUBLIC;
GRANT SELECT, INSERT ON payment_link_receivable_closures TO expense_warrior_app;

CREATE INDEX payment_link_receivable_closures_receivable_idx
  ON payment_link_receivable_closures (receivable_id, settled_at DESC, payment_link_id);

CREATE FUNCTION reject_payment_link_receivable_closure_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment-link receivable closures are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER payment_link_receivable_closures_append_only
  BEFORE UPDATE OR DELETE ON payment_link_receivable_closures
  FOR EACH ROW EXECUTE FUNCTION reject_payment_link_receivable_closure_mutation();

CREATE TRIGGER payment_link_receivable_closures_reject_truncate
  BEFORE TRUNCATE ON payment_link_receivable_closures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_payment_link_receivable_closure_mutation();
