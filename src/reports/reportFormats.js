const { PDFDocument } = require('pdfkit')
const ExcelJS = require('exceljs')

const CSV_COLUMNS = [
  ['request_id', 'request_id'],
  ['requester_customer_id', 'requester_id'],
  ['category_name', 'category'],
  ['subcategory_name', 'subcategory'],
  ['amount', 'amount'],
  ['currency', 'currency'],
  ['status', 'status'],
  ['submitted_at', 'submitted_at'],
  ['latest_decision_action', 'latest_decision'],
]
const WALLET_CSV_COLUMNS = [
  ['created_at', 'created_at'], ['entry_type', 'entry_type'], ['direction', 'direction'],
  ['amount', 'amount'], ['currency', 'currency'], ['running_balance', 'running_balance'],
  ['reference_type', 'reference_type'], ['reference_id', 'reference_id'], ['payment_method', 'payment_method'],
]
const XLSX_REQUEST_COLUMNS = [
  ['request_id', 'Request ID'], ['requester_customer_id', 'Requester ID'], ['category_name', 'Category'],
  ['subcategory_name', 'Subcategory'], ['amount', 'Amount'], ['currency', 'Currency'], ['status', 'Status'],
  ['submitted_at', 'Submitted at'], ['latest_decision_action', 'Latest decision'],
]
const XLSX_WALLET_COLUMNS = [
  ['created_at', 'Created at'], ['entry_type', 'Entry type'], ['direction', 'Direction'], ['amount', 'Amount'],
  ['currency', 'Currency'], ['running_balance', 'Running balance'], ['reference_type', 'Reference type'],
  ['reference_id', 'Reference ID'], ['payment_method', 'Payment method'],
]
const COLLECTIONS_COLUMNS = [
  ['created_at', 'created_at'], ['description', 'description'], ['collection_target_type', 'target_type'],
  ['amount', 'amount'], ['currency', 'currency'], ['state', 'state'], ['provider_code', 'provider'],
  ['network_label', 'network'], ['payer_last_four', 'payer_last_four'],
  ['provider_reference', 'provider_reference'], ['provider_transaction_id', 'provider_transaction_id'],
]
const XLSX_COLLECTIONS_COLUMNS = [
  ['created_at', 'Created at'], ['description', 'Description'], ['collection_target_type', 'Target type'],
  ['amount', 'Amount'], ['currency', 'Currency'], ['state', 'State'], ['provider_code', 'Provider'],
  ['network_label', 'Network'], ['payer_last_four', 'Payer last four'],
  ['provider_reference', 'Provider reference'], ['provider_transaction_id', 'Provider transaction ID'],
]

async function createWorkbook(rows, window, { name, title, columns }) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Expense Warrior'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(name)
  sheet.addRow([title])
  sheet.addRow([`Period: ${window.fromDate} to ${window.toDate} (${window.timeZone})`])
  sheet.addRow(columns.map(([, label]) => label))
  sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF18382E' } }
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF52645C' } }
  sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18382E' } }
  sheet.views = [{ state: 'frozen', ySplit: 3 }]
  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } }
  sheet.columns = columns.map(([, label]) => ({ header: label, key: label, width: Math.max(14, Math.min(28, label.length + 4)) }))
  // Assign strings explicitly so untrusted fields remain text cells, never formulas.
  rows.forEach((row) => sheet.addRow(columns.map(([key]) => row[key] == null ? '' : String(row[key]))))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function createXlsxReport(rows, window) {
  return createWorkbook(rows, window, { name: 'Requests', title: 'Expense Warrior — Request report', columns: XLSX_REQUEST_COLUMNS })
}

function createWalletXlsxReport(rows, window) {
  return createWorkbook(rows, window, { name: 'Wallet History', title: 'Expense Warrior — Petty-cash wallet history', columns: XLSX_WALLET_COLUMNS })
}

function createPaymentLinkCollectionsXlsxReport(rows, window) {
  return createWorkbook(rows, window, { name: 'Link Collections', title: 'Expense Warrior — Payment-link collections', columns: XLSX_COLLECTIONS_COLUMNS })
}

function escapeSpreadsheetCell(value) {
  const text = value == null ? '' : String(value)
  return /^[\u0009\u000D\u000A ]*[=+\-@]/.test(text) ? `'${text}` : text
}

function csvCell(value) {
  const text = escapeSpreadsheetCell(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function createCsvReport(rows, window) {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',')
  const lines = rows.map((row) => CSV_COLUMNS.map(([key]) => csvCell(row[key])).join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}

async function createPdfReport(rows, window) {
  const doc = new PDFDocument({ size: 'A4', margin: 44, autoFirstPage: true, compress: true })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const addHeading = () => {
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#18382e').text('Expense Warrior', { continued: false })
    doc.moveDown(0.25).font('Helvetica-Bold').fontSize(12).fillColor('#18382e').text('Request report')
    doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#52645c').text(`Period: ${window.fromDate} to ${window.toDate} (${window.timeZone})`)
    doc.text(`Requests: ${rows.length} · Currency: ZMW · Sorted newest first`)
    doc.moveDown(0.8)
  }
  addHeading()
  rows.forEach((row, index) => {
    if (doc.y > 740) {
      doc.addPage()
      addHeading()
    }
    const category = [row.category_name, row.subcategory_name].filter(Boolean).join(' / ')
    const decision = row.latest_decision_action ? ` · Latest decision: ${row.latest_decision_action}` : ''
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#253d34')
      .text(`${index + 1}. ${row.amount} ${row.currency} · ${row.status}`, { continued: false })
    doc.font('Helvetica').fontSize(8).fillColor('#52645c')
      .text(`${category} · Request ${row.request_id} · User ${row.requester_customer_id}${decision}`)
      .text(`Submitted: ${new Date(row.submitted_at).toISOString()}`)
    doc.moveDown(0.45)
  })
  doc.end()
  return completed
}

function createWalletCsvReport(rows) {
  const header = WALLET_CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',')
  const lines = rows.map((row) => WALLET_CSV_COLUMNS.map(([key]) => csvCell(row[key])).join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}

async function createWalletPdfReport(rows, window) {
  const doc = new PDFDocument({ size: 'A4', margin: 44, autoFirstPage: true, compress: true })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const addHeading = () => {
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#18382e').text('Expense Warrior', { continued: false })
    doc.moveDown(0.25).font('Helvetica-Bold').fontSize(12).fillColor('#18382e').text('Petty-cash wallet history')
    doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#52645c').text(`Period: ${window.fromDate} to ${window.toDate} (${window.timeZone})`)
    doc.text(`Posted entries: ${rows.length} · Currency: ZMW · Sorted newest first`)
    doc.moveDown(0.8)
  }
  addHeading()
  rows.forEach((row, index) => {
    if (doc.y > 740) { doc.addPage(); addHeading() }
    const sign = row.direction === 'in' ? '+' : '−'
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#253d34')
      .text(`${index + 1}. ${sign}${row.amount} ZMW · ${String(row.entry_type).replaceAll('_', ' ')}`)
    doc.font('Helvetica').fontSize(8).fillColor('#52645c')
      .text(`Balance: ${row.running_balance} ZMW · ${row.payment_method || 'Payment method unavailable'}`)
      .text(`Reference: ${row.reference_type || 'Treasury entry'}${row.reference_id ? ` · ${row.reference_id}` : ''}`)
      .text(`Posted: ${new Date(row.created_at).toISOString()}`)
    doc.moveDown(0.45)
  })
  doc.end()
  return completed
}

function createPaymentLinkCollectionsCsvReport(rows) {
  const header = COLLECTIONS_COLUMNS.map(([, label]) => csvCell(label)).join(',')
  const lines = rows.map((row) => COLLECTIONS_COLUMNS.map(([key]) => csvCell(row[key])).join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}

async function createPaymentLinkCollectionsPdfReport(rows, window) {
  const doc = new PDFDocument({ size: 'A4', margin: 44, autoFirstPage: true, compress: true })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const addHeading = () => {
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#18382e').text('Expense Warrior', { continued: false })
    doc.moveDown(0.25).font('Helvetica-Bold').fontSize(12).fillColor('#18382e').text('Payment-link collections report')
    doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor('#52645c').text(`Period: ${window.fromDate} to ${window.toDate} (${window.timeZone})`)
    doc.text(`Collection attempts: ${rows.length} · Sorted newest first`)
    doc.moveDown(0.8)
  }
  addHeading()
  rows.forEach((row, index) => {
    if (doc.y > 740) { doc.addPage(); addHeading() }
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#253d34')
      .text(`${index + 1}. ${row.amount} ${row.currency} · ${String(row.state).replaceAll('_', ' ')}`)
    doc.font('Helvetica').fontSize(8).fillColor('#52645c')
      .text(`${row.description || 'Payment link'} · ${row.collection_target_type || 'Target unavailable'} · ${row.provider_code || 'Provider unavailable'} / ${row.network_label || 'Network unavailable'}`)
      .text(`Payer ending ${row.payer_last_four || '—'} · Provider reference: ${row.provider_reference || 'Unavailable'} · Transaction: ${row.provider_transaction_id || 'Unavailable'}`)
      .text(`Created: ${new Date(row.created_at).toISOString()}`)
    doc.moveDown(0.45)
  })
  doc.end()
  return completed
}

module.exports = { createCsvReport, createPdfReport, createWalletCsvReport, createWalletPdfReport, createXlsxReport, createWalletXlsxReport, createPaymentLinkCollectionsCsvReport, createPaymentLinkCollectionsPdfReport, createPaymentLinkCollectionsXlsxReport, escapeSpreadsheetCell }
