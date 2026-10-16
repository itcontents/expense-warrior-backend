-- Provider adapters remain code/config deployed, while attempts, callbacks,
-- and balance history retain the identity of whichever registered account ran them.
-- This migration is source-only until explicitly applied through the approved rollout.

ALTER TABLE payment_link_attempts
  DROP CONSTRAINT payment_link_attempts_network_code_check,
  ADD CONSTRAINT payment_link_attempts_network_code_check
    CHECK (network_code ~ '^[A-Z0-9_]{1,32}$'),
  ADD COLUMN network_label varchar(80),
  ADD CONSTRAINT payment_link_attempts_network_label_check
    CHECK (network_label IS NULL OR (length(btrim(network_label)) BETWEEN 1 AND 80));

ALTER TABLE staff_payout_destinations
  DROP CONSTRAINT staff_payout_destinations_network_code_check,
  ADD CONSTRAINT staff_payout_destinations_network_code_check
    CHECK (network_code ~ '^[A-Z0-9_]{1,40}$');

ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_payout_snapshot_chk,
  ADD CONSTRAINT expense_requests_payout_snapshot_chk CHECK (
    (payout_destination_id IS NULL AND payout_network_code IS NULL AND payout_phone_ciphertext IS NULL
      AND payout_encryption_key_id IS NULL AND payout_phone_last4 IS NULL)
    OR
    (payout_destination_id IS NOT NULL AND payout_network_code ~ '^[A-Z0-9_]{1,40}$'
      AND payout_phone_ciphertext IS NOT NULL AND payout_encryption_key_id IS NOT NULL
      AND payout_phone_last4 ~ '^[0-9]{4}$')
  );

ALTER TABLE request_payout_attempts
  DROP CONSTRAINT request_payout_attempts_provider_code_check,
  DROP CONSTRAINT request_payout_attempts_network_code_check,
  ADD CONSTRAINT request_payout_attempts_provider_code_check
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT request_payout_attempts_network_code_check
    CHECK (network_code ~ '^[A-Z0-9_]{1,32}$'),
  ADD COLUMN provider_account_id uuid,
  ADD COLUMN provider_account_version integer,
  ADD CONSTRAINT request_payout_attempts_provider_account_pair_check
    CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    );

ALTER TABLE staff_payout_destinations
  ADD COLUMN provider_code varchar(32) NOT NULL DEFAULT 'pawapay',
  ADD CONSTRAINT staff_payout_destinations_provider_code_check
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$');

ALTER TABLE expense_requests
  ADD COLUMN payout_provider_code varchar(32),
  ADD COLUMN payout_provider_account_id uuid,
  ADD COLUMN payout_provider_account_version integer,
  ADD CONSTRAINT expense_requests_payout_provider_account_pair_check CHECK (
    (payout_provider_account_id IS NULL AND payout_provider_account_version IS NULL)
    OR (payout_destination_id IS NOT NULL AND payout_provider_account_id IS NOT NULL
      AND payout_provider_account_version > 0)
  );

UPDATE expense_requests
   SET payout_provider_code = 'pawapay'
 WHERE payout_destination_id IS NOT NULL AND payout_provider_code IS NULL;

ALTER TABLE expense_requests
  ADD CONSTRAINT expense_requests_payout_provider_snapshot_chk CHECK (
    (payout_destination_id IS NULL AND payout_provider_code IS NULL)
    OR (payout_destination_id IS NOT NULL AND payout_provider_code ~ '^[a-z][a-z0-9_]{1,31}$')
  );

CREATE OR REPLACE FUNCTION protect_staff_payout_destination_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff payout destinations are append-only';
  END IF;
  IF OLD.destination_id IS DISTINCT FROM NEW.destination_id
     OR OLD.staff_customer_id IS DISTINCT FROM NEW.staff_customer_id
     OR OLD.provider_code IS DISTINCT FROM NEW.provider_code
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

CREATE OR REPLACE FUNCTION protect_expense_request_payout_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payout_destination_id IS DISTINCT FROM NEW.payout_destination_id
     OR OLD.payout_provider_code IS DISTINCT FROM NEW.payout_provider_code
     OR OLD.payout_network_code IS DISTINCT FROM NEW.payout_network_code
     OR OLD.payout_phone_ciphertext IS DISTINCT FROM NEW.payout_phone_ciphertext
     OR OLD.payout_encryption_key_id IS DISTINCT FROM NEW.payout_encryption_key_id
     OR OLD.payout_phone_last4 IS DISTINCT FROM NEW.payout_phone_last4 THEN
    RAISE EXCEPTION 'expense request payout destination snapshots are immutable';
  END IF;
  IF OLD.payout_provider_account_id IS DISTINCT FROM NEW.payout_provider_account_id
     OR OLD.payout_provider_account_version IS DISTINCT FROM NEW.payout_provider_account_version THEN
    IF OLD.payout_provider_account_id IS NOT NULL
       OR OLD.payout_provider_account_version IS NOT NULL
       OR NEW.payout_provider_account_id IS NULL
       OR NEW.payout_provider_account_version IS NULL
       OR NEW.payout_provider_account_version <= 0 THEN
      RAISE EXCEPTION 'expense request provider account snapshot can only be set once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE request_payout_attempts
  ADD COLUMN provider_network_label varchar(80),
  ADD CONSTRAINT request_payout_attempts_provider_network_label_check
    CHECK (provider_network_label IS NULL OR length(btrim(provider_network_label)) BETWEEN 1 AND 80);

ALTER TABLE provider_callback_inbox
  DROP CONSTRAINT provider_callback_inbox_provider_code_check,
  ADD CONSTRAINT provider_callback_inbox_provider_code_check
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD COLUMN provider_account_id uuid,
  ADD COLUMN provider_account_version integer,
  ADD CONSTRAINT provider_callback_inbox_provider_account_pair_check
    CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    );

ALTER TABLE provider_balance_snapshot_batches
  DROP CONSTRAINT provider_balance_snapshot_batches_provider_code_check,
  ADD CONSTRAINT provider_balance_snapshot_batches_provider_code_check
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD COLUMN provider_account_id uuid,
  ADD COLUMN provider_account_version integer,
  ADD CONSTRAINT provider_balance_snapshot_batches_provider_account_pair_check
    CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    );

ALTER TABLE provider_balance_snapshot_items
  DROP CONSTRAINT provider_balance_snapshot_items_provider_code_check,
  ADD CONSTRAINT provider_balance_snapshot_items_provider_code_check
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{1,31}$');

CREATE INDEX provider_balance_snapshot_batches_account_recent_idx
  ON provider_balance_snapshot_batches
    (provider_code, provider_account_id, retrieved_at DESC, snapshot_batch_id DESC);
