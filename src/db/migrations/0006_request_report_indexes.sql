CREATE INDEX expense_requests_submitted_report_idx
  ON expense_requests (submitted_at DESC, request_id DESC);
