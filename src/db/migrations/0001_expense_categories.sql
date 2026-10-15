CREATE TABLE expense_categories (
  category_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_category_id uuid REFERENCES expense_categories(category_id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  reason_required boolean NOT NULL DEFAULT false,
  attachment_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_category_id IS NULL OR parent_category_id <> category_id),
  UNIQUE (category_id, parent_category_id)
);

CREATE INDEX expense_categories_active_parent_idx
  ON expense_categories (parent_category_id, code)
  WHERE is_active = true;

CREATE TEMP TABLE ew_category_seed (
  code text NOT NULL,
  name text NOT NULL,
  parent_code text,
  reason_required boolean NOT NULL,
  attachment_required boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO ew_category_seed VALUES
    ('STOCK_PURCHASING', 'Stock and Purchasing', NULL::text, false, false),
    ('RESALE_INVENTORY', 'Resale inventory', 'STOCK_PURCHASING', false, false),
    ('SUPPLIER_TOP_UP', 'Supplier top-up', 'STOCK_PURCHASING', false, false),
    ('RESALE_PACKAGING', 'Packaging for resale', 'STOCK_PURCHASING', false, false),
    ('TRANSPORT_TRAVEL', 'Transport and Travel', NULL, false, false),
    ('LOCAL_TRANSPORT', 'Local transport', 'TRANSPORT_TRAVEL', false, false),
    ('FUEL', 'Fuel', 'TRANSPORT_TRAVEL', false, false),
    ('PARKING_TOLLS', 'Parking and tolls', 'TRANSPORT_TRAVEL', false, false),
    ('DELIVERY_DISPATCH', 'Delivery and dispatch', 'TRANSPORT_TRAVEL', false, false),
    ('OVERTIME_CASUAL_LABOUR', 'Overtime and Casual Labour', NULL, false, false),
    ('STAFF_OVERTIME', 'Staff overtime', 'OVERTIME_CASUAL_LABOUR', false, false),
    ('TEMPORARY_LABOUR', 'Temporary or casual labour', 'OVERTIME_CASUAL_LABOUR', false, false),
    ('SHIPPING_COURIER', 'Shipping and Courier', NULL, false, false),
    ('COURIER', 'Courier', 'SHIPPING_COURIER', false, false),
    ('FREIGHT', 'Freight', 'SHIPPING_COURIER', false, false),
    ('PARCEL_DELIVERY', 'Parcel delivery', 'SHIPPING_COURIER', false, false),
    ('OFFICE_SUPPLIES', 'Office Supplies', NULL, false, false),
    ('STATIONERY', 'Stationery', 'OFFICE_SUPPLIES', false, false),
    ('CLEANING_SUPPLIES', 'Cleaning supplies', 'OFFICE_SUPPLIES', false, false),
    ('OFFICE_CONSUMABLES', 'Small office consumables', 'OFFICE_SUPPLIES', false, false),
    ('PHONE_INTERNET', 'Phone and Internet', NULL, false, false),
    ('MOBILE_DATA', 'Mobile data', 'PHONE_INTERNET', false, false),
    ('AIRTIME_TALKTIME', 'Airtime and talktime', 'PHONE_INTERNET', false, false),
    ('INTERNET_BUNDLE', 'Internet bundle', 'PHONE_INTERNET', false, false),
    ('UTILITIES', 'Utilities', NULL, false, false),
    ('ELECTRICITY', 'Electricity', 'UTILITIES', false, false),
    ('WATER', 'Water', 'UTILITIES', false, false),
    ('OTHER_UTILITY', 'Other approved utility', 'UTILITIES', false, false),
    ('REPAIRS_MAINTENANCE', 'Repairs and Maintenance', NULL, false, false),
    ('OFFICE_REPAIRS', 'Office repairs', 'REPAIRS_MAINTENANCE', false, false),
    ('EQUIPMENT_REPAIRS', 'Equipment repairs', 'REPAIRS_MAINTENANCE', false, false),
    ('VEHICLE_REPAIRS', 'Vehicle repairs', 'REPAIRS_MAINTENANCE', false, false),
    ('MEALS_MEETINGS', 'Meals and Meetings', NULL, false, false),
    ('STAFF_MEALS', 'Staff meal', 'MEALS_MEETINGS', false, false),
    ('MEETING_REFRESHMENTS', 'Meeting refreshments', 'MEALS_MEETINGS', false, false),
    ('BANK_SERVICE_CHARGES', 'Bank and Service Charges', NULL, false, false),
    ('BANK_FEE', 'Bank fee', 'BANK_SERVICE_CHARGES', false, false),
    ('MOBILE_MONEY_FEE', 'Mobile-money fee', 'BANK_SERVICE_CHARGES', false, false),
    ('OTHER_SERVICE_CHARGE', 'Other service charge', 'BANK_SERVICE_CHARGES', false, false),
    ('OTHER', 'Other', NULL, true, false);

INSERT INTO expense_categories (code, name, reason_required, attachment_required)
SELECT code, name, reason_required, attachment_required
  FROM ew_category_seed
 WHERE parent_code IS NULL
ON CONFLICT (code) DO NOTHING;

INSERT INTO expense_categories (parent_category_id, code, name, reason_required, attachment_required)
SELECT parent.category_id, child.code, child.name, child.reason_required, child.attachment_required
  FROM ew_category_seed child
  JOIN expense_categories parent ON parent.code = child.parent_code
 WHERE child.parent_code IS NOT NULL
ON CONFLICT (code) DO NOTHING;
