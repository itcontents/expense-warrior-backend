CREATE TABLE provider_balance_snapshot_batches (
  snapshot_batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(32) NOT NULL CHECK (provider_code = 'pawapay'),
  country char(3) NOT NULL CHECK (country = 'ZMB'),
  retrieved_at timestamptz NOT NULL,
  balance_count integer NOT NULL CHECK (balance_count BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX provider_balance_snapshot_batches_recent_idx
  ON provider_balance_snapshot_batches (retrieved_at DESC, snapshot_batch_id DESC);

CREATE TABLE provider_balance_snapshot_items (
  snapshot_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_batch_id uuid NOT NULL REFERENCES provider_balance_snapshot_batches(snapshot_batch_id) ON DELETE RESTRICT,
  provider_code varchar(32) NOT NULL CHECK (provider_code = 'pawapay'),
  network_code varchar(40) CHECK (network_code IS NULL OR network_code ~ '^[A-Z0-9_]{1,40}$'),
  currency char(3) NOT NULL CHECK (currency = 'ZMW'),
  balance numeric(14,4) NOT NULL CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE UNIQUE INDEX provider_balance_snapshot_items_network_unique_idx
  ON provider_balance_snapshot_items (snapshot_batch_id, COALESCE(network_code, ''));

CREATE INDEX provider_balance_snapshot_items_batch_idx
  ON provider_balance_snapshot_items (snapshot_batch_id, network_code);

CREATE FUNCTION reject_provider_balance_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider balance snapshots are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER provider_balance_snapshot_batches_append_only
  BEFORE UPDATE OR DELETE ON provider_balance_snapshot_batches
  FOR EACH ROW EXECUTE FUNCTION reject_provider_balance_snapshot_mutation();

CREATE TRIGGER provider_balance_snapshot_items_append_only
  BEFORE UPDATE OR DELETE ON provider_balance_snapshot_items
  FOR EACH ROW EXECUTE FUNCTION reject_provider_balance_snapshot_mutation();

CREATE TRIGGER provider_balance_snapshot_batches_reject_truncate
  BEFORE TRUNCATE ON provider_balance_snapshot_batches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_balance_snapshot_mutation();

CREATE TRIGGER provider_balance_snapshot_items_reject_truncate
  BEFORE TRUNCATE ON provider_balance_snapshot_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_balance_snapshot_mutation();
