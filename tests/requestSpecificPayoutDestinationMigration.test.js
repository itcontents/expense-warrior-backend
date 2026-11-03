const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/0019_request_specific_payout_destinations.sql'), 'utf8')

test('request payout migration permits immutable request-only snapshots and provider account identity', () => {
  assert.match(sql, /DROP CONSTRAINT expense_requests_payout_snapshot_chk/)
  assert.match(sql, /payout_phone_ciphertext IS NOT NULL/)
  assert.match(sql, /payout_encryption_key_id IS NOT NULL/)
  assert.match(sql, /DROP CONSTRAINT expense_requests_payout_provider_snapshot_chk/)
  assert.match(sql, /DROP CONSTRAINT expense_requests_payout_provider_account_pair_check/)
  assert.match(sql, /payout_provider_code IS NOT NULL AND payout_provider_account_id IS NOT NULL/)
})
