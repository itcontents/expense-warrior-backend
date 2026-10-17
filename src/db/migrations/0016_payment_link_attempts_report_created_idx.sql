-- Supports date-window exports across all payment links, ordered newest first.
-- The current migration runner wraps migrations in a transaction, so this index
-- is built non-concurrently and takes a write-blocking lock while it is created.
CREATE INDEX payment_link_attempts_report_created_idx
  ON payment_link_attempts (created_at DESC, attempt_id DESC);
