CREATE TABLE staff_payout_destinations (
  destination_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_customer_id uuid NOT NULL,
  network_code text NOT NULL CHECK (network_code IN ('AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB')),
  phone_ciphertext text NOT NULL CHECK (length(phone_ciphertext) BETWEEN 40 AND 256),
  encryption_key_id text NOT NULL CHECK (length(encryption_key_id) BETWEEN 1 AND 64),
  phone_fingerprint char(64) NOT NULL CHECK (phone_fingerprint ~ '^[0-9a-f]{64}$'),
  phone_last4 char(4) NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
  assigned_by_customer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  superseded_at timestamptz,
  CHECK (superseded_at IS NULL OR superseded_at > created_at)
);

CREATE UNIQUE INDEX staff_payout_destinations_one_current_idx
  ON staff_payout_destinations (staff_customer_id) WHERE superseded_at IS NULL;
CREATE INDEX staff_payout_destinations_history_idx
  ON staff_payout_destinations (staff_customer_id, created_at DESC, destination_id DESC);

CREATE FUNCTION protect_staff_payout_destination_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff payout destinations are append-only';
  END IF;
  IF OLD.destination_id IS DISTINCT FROM NEW.destination_id
     OR OLD.staff_customer_id IS DISTINCT FROM NEW.staff_customer_id
     OR OLD.network_code IS DISTINCT FROM NEW.network_code
     OR OLD.phone_ciphertext IS DISTINCT FROM NEW.phone_ciphertext
     OR OLD.encryption_key_id IS DISTINCT FROM NEW.encryption_key_id
     OR OLD.phone_fingerprint IS DISTINCT FROM NEW.phone_fingerprint
     OR OLD.phone_last4 IS DISTINCT FROM NEW.phone_last4
     OR OLD.assigned_by_customer_id IS DISTINCT FROM NEW.assigned_by_customer_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.superseded_at IS NOT NULL
     OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'staff payout destinations can only be superseded once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_payout_destinations_append_only
  BEFORE UPDATE OR DELETE ON staff_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION protect_staff_payout_destination_history();

ALTER TABLE expense_requests
  ADD COLUMN payout_destination_id uuid REFERENCES staff_payout_destinations(destination_id) ON DELETE RESTRICT,
  ADD COLUMN payout_network_code text,
  ADD COLUMN payout_phone_ciphertext text,
  ADD COLUMN payout_encryption_key_id text,
  ADD COLUMN payout_phone_last4 char(4),
  ADD CONSTRAINT expense_requests_payout_snapshot_chk CHECK (
    (payout_destination_id IS NULL AND payout_network_code IS NULL AND payout_phone_ciphertext IS NULL
      AND payout_encryption_key_id IS NULL AND payout_phone_last4 IS NULL)
    OR
    (payout_destination_id IS NOT NULL AND payout_network_code IN ('AIRTEL_OAPI_ZMB', 'MTN_MOMO_ZMB', 'ZAMTEL_ZMB')
      AND payout_phone_ciphertext IS NOT NULL AND payout_encryption_key_id IS NOT NULL
      AND payout_phone_last4 ~ '^[0-9]{4}$')
  );

CREATE FUNCTION protect_expense_request_payout_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payout_destination_id IS DISTINCT FROM NEW.payout_destination_id
     OR OLD.payout_network_code IS DISTINCT FROM NEW.payout_network_code
     OR OLD.payout_phone_ciphertext IS DISTINCT FROM NEW.payout_phone_ciphertext
     OR OLD.payout_encryption_key_id IS DISTINCT FROM NEW.payout_encryption_key_id
     OR OLD.payout_phone_last4 IS DISTINCT FROM NEW.payout_phone_last4 THEN
    RAISE EXCEPTION 'expense request payout destination snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expense_request_payout_snapshot_immutable
  BEFORE UPDATE ON expense_requests
  FOR EACH ROW EXECUTE FUNCTION protect_expense_request_payout_snapshot();
