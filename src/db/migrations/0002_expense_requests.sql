CREATE TABLE employee_manager_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_customer_id uuid NOT NULL,
  manager_customer_id uuid NOT NULL,
  assigned_by_customer_id uuid NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (staff_customer_id <> manager_customer_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX employee_manager_one_current_assignment_idx
  ON employee_manager_assignments (staff_customer_id)
  WHERE effective_to IS NULL;

CREATE INDEX employee_manager_manager_scope_idx
  ON employee_manager_assignments (manager_customer_id, staff_customer_id)
  WHERE effective_to IS NULL;

CREATE TABLE expense_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_customer_id uuid NOT NULL,
  category_id uuid NOT NULL REFERENCES expense_categories(category_id) ON DELETE RESTRICT,
  subcategory_id uuid,
  manager_assignment_id uuid REFERENCES employee_manager_assignments(assignment_id) ON DELETE RESTRICT,
  reviewer_manager_customer_id uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'ZMW' CHECK (currency = 'ZMW'),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  status text NOT NULL CHECK (status IN (
    'PENDING_MANAGER',
    'MANAGER_APPROVAL_PENDING_HOLD',
    'MANAGER_APPROVED',
    'PENDING_ADMIN',
    'APPROVED_AWAITING_PAYOUT',
    'PAYOUT_PENDING',
    'PAID',
    'REJECTED_MANAGER',
    'REJECTED_ADMIN'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subcategory_id, category_id)
    REFERENCES expense_categories(category_id, parent_category_id)
    ON DELETE RESTRICT
);

CREATE TABLE expense_request_attachments (
  attachment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES expense_requests(request_id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f-]{36}[.](jpg|png|webp)$'),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 5242880),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploader_customer_id uuid NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expense_request_attachments_request_idx
  ON expense_request_attachments (request_id, uploaded_at, attachment_id);

CREATE INDEX expense_requests_requester_created_idx
  ON expense_requests (requester_customer_id, created_at DESC, request_id DESC);

CREATE INDEX expense_requests_status_created_idx
  ON expense_requests (status, created_at DESC, request_id DESC);

CREATE INDEX expense_requests_manager_queue_idx
  ON expense_requests (reviewer_manager_customer_id, created_at DESC, request_id DESC)
  WHERE status IN ('PENDING_MANAGER', 'MANAGER_APPROVAL_PENDING_HOLD');

CREATE TABLE request_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES expense_requests(request_id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('manager', 'admin')),
  action text NOT NULL CHECK (action IN ('approve', 'reject')),
  actor_customer_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, stage),
  CHECK (action <> 'reject' OR length(btrim(COALESCE(reason, ''))) > 0)
);

CREATE TABLE idempotency_records (
  actor_customer_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  resource_id uuid,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (actor_customer_id, operation, idempotency_key),
  CHECK ((response_json IS NULL) = (completed_at IS NULL))
);

CREATE TABLE audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_customer_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 60),
  target_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_target_created_idx
  ON audit_events (target_type, target_id, created_at DESC);
