ALTER TABLE expense_categories
  ADD COLUMN itc_expense_category_code text,
  ADD CONSTRAINT expense_categories_itc_accounting_code_chk
    CHECK (itc_expense_category_code IS NULL OR itc_expense_category_code ~ '^[a-z][a-z0-9_]{1,49}$');

ALTER TABLE expense_requests
  ADD COLUMN finance_expense_category_code text,
  ADD COLUMN finance_expense_account_code text,
  ADD CONSTRAINT expense_requests_finance_expense_category_code_chk
    CHECK (finance_expense_category_code IS NULL OR finance_expense_category_code ~ '^[a-z][a-z0-9_]{1,49}$'),
  ADD CONSTRAINT expense_requests_finance_expense_account_code_chk
    CHECK (finance_expense_account_code IS NULL OR finance_expense_account_code ~ '^[0-9]{4}$'),
  ADD CONSTRAINT expense_requests_finance_expense_mapping_pair_chk
    CHECK (finance_expense_account_code IS NULL OR finance_expense_category_code IS NOT NULL),
  ADD CONSTRAINT expense_requests_reserved_finance_expense_mapping_chk
    CHECK (finance_reservation_state NOT IN ('RESERVED','RELEASED') OR
      (finance_expense_category_code IS NOT NULL AND finance_expense_account_code IS NOT NULL));
