ALTER TABLE expense_requests
  DROP CONSTRAINT expense_requests_status_check,
  ADD CONSTRAINT expense_requests_status_check CHECK (status IN (
    'PENDING_MANAGER',
    'MANAGER_APPROVAL_PENDING_HOLD',
    'MANAGER_APPROVED',
    'PENDING_ADMIN',
    'APPROVED_AWAITING_PAYOUT',
    'PAYOUT_PENDING',
    'PAID',
    'PAYOUT_FAILED',
    'REJECTED_MANAGER',
    'REJECTED_ADMIN',
    'CANCELED'
  ));
