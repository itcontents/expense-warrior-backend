DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO expense_warrior_app, expense_warrior_migrator', current_database());
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, expense_warrior_app;
GRANT USAGE ON SCHEMA public TO expense_warrior_app;

REVOKE ALL PRIVILEGES ON TABLE
  employee_manager_assignments,
  expense_categories,
  expense_request_attachments,
  expense_requests,
  expense_warrior_schema_migrations,
  idempotency_records,
  audit_events,
  payment_link_attempts,
  payment_link_creation_requests,
  payment_link_receivable_closures,
  payment_links,
  provider_balance_snapshot_batches,
  provider_balance_snapshot_items,
  provider_callback_inbox,
  request_decisions,
  request_payout_attempts,
  staff_payout_destinations
FROM PUBLIC, expense_warrior_app;

GRANT SELECT ON TABLE
  employee_manager_assignments,
  expense_categories,
  expense_request_attachments,
  expense_requests,
  idempotency_records,
  payment_link_attempts,
  payment_link_creation_requests,
  payment_link_receivable_closures,
  payment_links,
  provider_balance_snapshot_batches,
  provider_balance_snapshot_items,
  request_decisions,
  request_payout_attempts,
  staff_payout_destinations
TO expense_warrior_app;

GRANT INSERT ON TABLE
  audit_events,
  employee_manager_assignments,
  expense_request_attachments,
  expense_requests,
  idempotency_records,
  payment_link_attempts,
  payment_link_creation_requests,
  payment_link_receivable_closures,
  payment_links,
  provider_balance_snapshot_batches,
  provider_balance_snapshot_items,
  provider_callback_inbox,
  request_decisions,
  request_payout_attempts,
  staff_payout_destinations
TO expense_warrior_app;

GRANT UPDATE (effective_to) ON TABLE employee_manager_assignments TO expense_warrior_app;
GRANT UPDATE (itc_expense_category_code, updated_at) ON TABLE expense_categories TO expense_warrior_app;
GRANT UPDATE (resource_id, response_json, completed_at) ON TABLE idempotency_records TO expense_warrior_app;
GRANT UPDATE (
  finance_operation_id, finance_idempotency_key, finance_reservation_state, finance_error_code,
  finance_expense_category_code, finance_expense_account_code, payout_provider_account_id,
  payout_provider_account_version, updated_at, status, finance_hold_id,
  finance_release_operation_id, finance_release_idempotency_key, finance_release_state,
  finance_release_actor_customer_id, finance_release_reason, finance_release_error_code,
  manager_assignment_id, reviewer_manager_customer_id
) ON TABLE expense_requests TO expense_warrior_app;
GRANT UPDATE (
  state, provider_status, provider_reference, last_error_code, verified_at,
  provider_evidence_digest, updated_at, ledger_operation_id
) ON TABLE payment_link_attempts TO expense_warrior_app;
GRANT UPDATE (disabled_at, disabled_by_customer_id, status) ON TABLE payment_links TO expense_warrior_app;
GRANT UPDATE (
  state, reservation_hold_id, reservation_state, error_code, updated_at,
  provider_status, provider_transaction_reference, verified_at, consume_state,
  release_operation_id, release_idempotency_key, release_state, release_error_code
) ON TABLE request_payout_attempts TO expense_warrior_app;
GRANT UPDATE (superseded_at) ON TABLE staff_payout_destinations TO expense_warrior_app;
