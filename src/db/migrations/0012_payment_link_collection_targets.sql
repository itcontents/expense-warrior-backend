ALTER TABLE payment_links
  ADD COLUMN collection_target_type text NOT NULL DEFAULT 'UNCONFIGURED',
  ADD COLUMN revenue_account_code char(4),
  ADD COLUMN customer_id uuid,
  ADD COLUMN receivable_id uuid;

ALTER TABLE payment_links
  ADD CONSTRAINT payment_links_collection_target_chk CHECK (
    (collection_target_type = 'UNCONFIGURED' AND revenue_account_code IS NULL AND customer_id IS NULL AND receivable_id IS NULL) OR
    (collection_target_type = 'REVENUE' AND revenue_account_code ~ '^[0-9]{4}$' AND customer_id IS NULL AND receivable_id IS NULL) OR
    (collection_target_type = 'CUSTOMER_CREDIT' AND revenue_account_code IS NULL AND customer_id IS NOT NULL AND receivable_id IS NULL) OR
    (collection_target_type = 'AR_SETTLEMENT' AND revenue_account_code IS NULL AND customer_id IS NOT NULL AND receivable_id IS NOT NULL)
  );

ALTER TABLE payment_link_attempts
  ADD COLUMN provider_evidence_digest char(64)
  CHECK (provider_evidence_digest IS NULL OR provider_evidence_digest ~ '^[0-9a-f]{64}$');

CREATE INDEX payment_links_customer_target_idx ON payment_links (customer_id, created_at DESC, payment_link_id DESC)
  WHERE collection_target_type IN ('CUSTOMER_CREDIT', 'AR_SETTLEMENT');

CREATE INDEX payment_links_receivable_target_idx ON payment_links (receivable_id, created_at DESC, payment_link_id DESC)
  WHERE collection_target_type = 'AR_SETTLEMENT';
