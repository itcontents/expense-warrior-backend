-- Preserve payment-link tokens only as authenticated ciphertext so admins can
-- recover the original URL without exposing plaintext to database readers.
ALTER TABLE payment_links
  ADD COLUMN public_token_ciphertext text,
  ADD COLUMN public_token_encryption_key_id varchar(64),
  ADD CONSTRAINT payment_links_public_token_encryption_pair_check CHECK (
    (public_token_ciphertext IS NULL AND public_token_encryption_key_id IS NULL)
    OR (public_token_ciphertext IS NOT NULL AND public_token_encryption_key_id IS NOT NULL)
  );

-- Runtime token retrieval and rotation update only these token fields.
GRANT UPDATE (public_token_hash, public_token_ciphertext, public_token_encryption_key_id)
  ON TABLE payment_links TO expense_warrior_app;
