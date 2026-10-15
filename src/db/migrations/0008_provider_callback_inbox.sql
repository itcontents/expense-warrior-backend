CREATE TABLE provider_callback_inbox (
  callback_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL CHECK (provider_code = 'pawapay'),
  transaction_type text NOT NULL CHECK (transaction_type IN ('deposit', 'payout')),
  transaction_id varchar(36) NOT NULL CHECK (transaction_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'),
  provider_status varchar(40) NOT NULL CHECK (provider_status ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  provider_reference varchar(128),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_key_id varchar(128),
  signature_date timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider_code, payload_sha256)
);

CREATE INDEX provider_callback_inbox_transaction_idx
  ON provider_callback_inbox (provider_code, transaction_type, transaction_id, received_at DESC);

CREATE FUNCTION reject_provider_callback_inbox_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider callback inbox is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER provider_callback_inbox_append_only
  BEFORE UPDATE OR DELETE ON provider_callback_inbox
  FOR EACH ROW EXECUTE FUNCTION reject_provider_callback_inbox_mutation();

CREATE TRIGGER provider_callback_inbox_reject_truncate
  BEFORE TRUNCATE ON provider_callback_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_callback_inbox_mutation();
