-- A request may snapshot a payout destination supplied for that request only.
-- The encrypted number and provider/network identity remain immutable; an
-- optional destination FK identifies the saved-account path.
ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_payout_snapshot_chk,
  ADD CONSTRAINT expense_requests_payout_snapshot_chk CHECK (
    (payout_destination_id IS NULL AND payout_network_code IS NULL AND payout_phone_ciphertext IS NULL
      AND payout_encryption_key_id IS NULL AND payout_phone_last4 IS NULL)
    OR
    (payout_network_code ~ '^[A-Z0-9_]{1,40}$'
      AND payout_phone_ciphertext IS NOT NULL AND payout_encryption_key_id IS NOT NULL
      AND payout_phone_last4 ~ '^[0-9]{4}$')
  );

ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_payout_provider_snapshot_chk,
  ADD CONSTRAINT expense_requests_payout_provider_snapshot_chk CHECK (
    (payout_destination_id IS NULL AND payout_provider_code IS NULL AND payout_network_code IS NULL)
    OR
    (payout_provider_code ~ '^[a-z][a-z0-9_]{1,31}$'
      AND payout_network_code ~ '^[A-Z0-9_]{1,40}$')
  );

ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_payout_provider_account_pair_check,
  ADD CONSTRAINT expense_requests_payout_provider_account_pair_check CHECK (
    (payout_provider_account_id IS NULL AND payout_provider_account_version IS NULL)
    OR (payout_provider_code IS NOT NULL AND payout_provider_account_id IS NOT NULL
      AND payout_provider_account_version > 0)
  );
