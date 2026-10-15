const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migrationPath = path.join(__dirname, '../src/db/migrations/0001_expense_categories.sql')
const migration = fs.readFileSync(migrationPath, 'utf8')
const accountingMapMigration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/0009_expense_category_itc_mapping.sql'), 'utf8')
const seedRows = [...migration.matchAll(/\('([A-Z0-9_]+)', '([^']+)', (NULL(?:::text)?|'[A-Z0-9_]+'(?:::text)?), (true|false), (true|false)\)/g)]
  .map(([, code, name, parent, reasonRequired, attachmentRequired]) => ({
    code,
    name,
    parentCode: parent.startsWith('NULL') ? null : parent.match(/[A-Z0-9_]+/)[0],
    reasonRequired: reasonRequired === 'true',
    attachmentRequired: attachmentRequired === 'true',
  }))

test('categorySeed_matchesApprovedV1Hierarchy', () => {
  const expected = {
    STOCK_PURCHASING: ['RESALE_INVENTORY', 'SUPPLIER_TOP_UP', 'RESALE_PACKAGING'],
    TRANSPORT_TRAVEL: ['LOCAL_TRANSPORT', 'FUEL', 'PARKING_TOLLS', 'DELIVERY_DISPATCH'],
    OVERTIME_CASUAL_LABOUR: ['STAFF_OVERTIME', 'TEMPORARY_LABOUR'],
    SHIPPING_COURIER: ['COURIER', 'FREIGHT', 'PARCEL_DELIVERY'],
    OFFICE_SUPPLIES: ['STATIONERY', 'CLEANING_SUPPLIES', 'OFFICE_CONSUMABLES'],
    PHONE_INTERNET: ['MOBILE_DATA', 'AIRTIME_TALKTIME', 'INTERNET_BUNDLE'],
    UTILITIES: ['ELECTRICITY', 'WATER', 'OTHER_UTILITY'],
    REPAIRS_MAINTENANCE: ['OFFICE_REPAIRS', 'EQUIPMENT_REPAIRS', 'VEHICLE_REPAIRS'],
    MEALS_MEETINGS: ['STAFF_MEALS', 'MEETING_REFRESHMENTS'],
    BANK_SERVICE_CHARGES: ['BANK_FEE', 'MOBILE_MONEY_FEE', 'OTHER_SERVICE_CHARGE'],
    OTHER: [],
  }
  const actual = Object.fromEntries(seedRows.filter((row) => !row.parentCode).map((row) => [
    row.code,
    seedRows.filter((child) => child.parentCode === row.code).map((child) => child.code),
  ]))

  assert.deepEqual(actual, expected)
  assert.equal(seedRows.find((row) => row.code === 'OTHER').reasonRequired, true)
  assert.ok(seedRows.every((row) => row.attachmentRequired === false))
  assert.equal(seedRows.length, 40)
})

test('categoryAccountingMapMigrationPersistsExplicitMapsAndPayoutSnapshots', () => {
  assert.match(accountingMapMigration, /ADD COLUMN itc_expense_category_code text/)
  assert.match(accountingMapMigration, /finance_expense_category_code/)
  assert.match(accountingMapMigration, /finance_expense_account_code/)
  assert.match(accountingMapMigration, /expense_requests_reserved_finance_expense_mapping_chk/)
})
