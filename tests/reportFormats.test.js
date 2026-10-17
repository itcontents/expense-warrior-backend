const test = require('node:test')
const assert = require('node:assert/strict')
const { createCsvReport, createPdfReport, createWalletCsvReport, createWalletPdfReport, createXlsxReport, createWalletXlsxReport, createPaymentLinkCollectionsCsvReport, createPaymentLinkCollectionsPdfReport, createPaymentLinkCollectionsXlsxReport, escapeSpreadsheetCell } = require('../src/reports/reportFormats')

const rows = [{ request_id: 'abc', requester_customer_id: 'user-1', category_name: 'Office', subcategory_name: null, amount: '50.00', currency: 'ZMW', status: 'PAID', submitted_at: '2026-10-15T10:00:00.000Z', latest_decision_action: 'approve' }]

test('CSV escapes spreadsheet formulas and uses a stable report header', () => {
  assert.equal(escapeSpreadsheetCell(' =1+1'), "' =1+1")
  assert.equal(escapeSpreadsheetCell('+1'), "'+1")
  assert.equal(escapeSpreadsheetCell('-2'), "'-2")
  assert.equal(escapeSpreadsheetCell('@SUM(A1:A2)'), "'@SUM(A1:A2)")
  const csv = createCsvReport(rows, { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  assert.match(csv, /request_id,requester_id,category,subcategory,amount,currency,status,submitted_at,latest_decision/)
  assert.match(csv, /abc,user-1,Office,,50\.00,ZMW,PAID/)
})

test('PDF report creates a valid PDF buffer', async () => {
  const pdf = await createPdfReport(rows, { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  assert.equal(Buffer.isBuffer(pdf), true)
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('wallet history CSV escapes cells and PDF renders a bounded ledger summary', async () => {
  const walletRows = [{ treasury_ledger_id: 'id', entry_type: 'collection_credit', direction: 'in', amount: '25.00', running_balance: '125.00', currency: 'ZMW', reference_type: '=unsafe', reference_id: 'ref', payment_method: 'mobile_money', created_at: '2026-10-15T10:00:00.000Z' }]
  const csv = createWalletCsvReport(walletRows)
  assert.match(csv, /created_at,entry_type,direction,amount,currency,running_balance,reference_type,reference_id,payment_method/)
  assert.match(csv, /'\=unsafe/)
  const pdf = await createWalletPdfReport(walletRows, { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  assert.equal(Buffer.isBuffer(pdf), true)
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('XLSX exports keep untrusted values as text and expose stable request and wallet columns', async () => {
  const requestBook = await createXlsxReport([{ ...rows[0], category_name: '=1+1' }], { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  const walletBook = await createWalletXlsxReport([{ treasury_ledger_id: 'id', entry_type: 'credit', direction: 'in', amount: '25.00', running_balance: '125.00', currency: 'ZMW', reference_type: '=unsafe', reference_id: 'ref', payment_method: 'mobile_money', created_at: '2026-10-15T10:00:00.000Z' }], { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  assert.equal(requestBook.subarray(0, 2).toString(), 'PK')
  assert.equal(walletBook.subarray(0, 2).toString(), 'PK')
  const ExcelJS = require('exceljs')
  const request = new ExcelJS.Workbook()
  await request.xlsx.load(requestBook)
  assert.equal(request.getWorksheet('Requests').getCell('C4').value, '=1+1')
  assert.equal(request.getWorksheet('Requests').getCell('C4').type, ExcelJS.ValueType.String)
  const wallet = new ExcelJS.Workbook()
  await wallet.xlsx.load(walletBook)
  assert.equal(wallet.getWorksheet('Wallet History').getCell('G4').value, '=unsafe')
  assert.equal(wallet.getWorksheet('Wallet History').getCell('G4').type, ExcelJS.ValueType.String)
})

test('payment-link collection CSV and PDF include provider references and masked payer only', async () => {
  const collectionRows = [{ created_at: '2026-10-15T10:00:00.000Z', description: 'Customer payment', collection_target_type: 'revenue', amount: '25.00', currency: 'ZMW', state: 'SUCCEEDED', provider_code: 'pawapay', network_label: 'Airtel', payer_last_four: '9783', provider_reference: 'ref-123', provider_transaction_id: 'tx-456' }]
  const csv = createPaymentLinkCollectionsCsvReport(collectionRows)
  assert.match(csv, /created_at,description,target_type,amount,currency,state,provider,network,payer_last_four,provider_reference,provider_transaction_id/)
  assert.match(csv, /9783,ref-123,tx-456/)
  assert.doesNotMatch(csv, /260957909783/)
  const pdf = await createPaymentLinkCollectionsPdfReport(collectionRows, { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('payment-link collection XLSX exports untrusted provider fields as text', async () => {
  const bookBytes = await createPaymentLinkCollectionsXlsxReport([{ created_at: '2026-10-15T10:00:00Z', description: '=1+1', collection_target_type: 'revenue', amount: '5.00', currency: 'ZMW', state: 'SUCCEEDED', provider_code: 'pawapay', network_label: 'Airtel', payer_last_four: '9783', provider_reference: '@SUM(A1)', provider_transaction_id: '+tx' }], { fromDate: '2026-10-15', toDate: '2026-10-15', timeZone: 'Africa/Lusaka' })
  const ExcelJS = require('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bookBytes)
  const sheet = workbook.getWorksheet('Link Collections')
  assert.equal(sheet.getCell('B4').value, '=1+1')
  assert.equal(sheet.getCell('B4').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('J4').value, '@SUM(A1)')
  assert.equal(sheet.getCell('J4').type, ExcelJS.ValueType.String)
})
