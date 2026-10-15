ALTER TABLE payment_link_attempts
  ADD COLUMN provider_account_id uuid,
  ADD COLUMN provider_account_version integer,
  ADD CONSTRAINT payment_link_attempts_provider_account_pair_check
    CHECK (
      (provider_account_id IS NULL AND provider_account_version IS NULL)
      OR (provider_account_id IS NOT NULL AND provider_account_version > 0)
    );
