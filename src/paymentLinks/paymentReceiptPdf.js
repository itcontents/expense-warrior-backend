const { PDFDocument } = require('pdfkit')

function createPaymentReceiptPdf(receipt) {
  const doc = new PDFDocument({ size: 'A5', margin: 36, compress: true, info: { Title: 'Expense Warrior payment receipt' } })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  doc.font('Helvetica-Bold').fontSize(19).fillColor('#18382e').text('Expense Warrior')
  doc.moveDown(0.7)
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#17866c').text('Payment received')
  doc.moveDown(0.3)
  doc.font('Helvetica-Bold').fontSize(23).fillColor('#18382e').text(`${receipt.amount} ${receipt.currency}`)
  doc.moveDown(0.8)

  const rows = [
    ['Payment for', receipt.description],
    ['Network', receipt.network],
    ['Paid from', `Mobile money ending ${receipt.phoneLast4}`],
    ['Received', receipt.paidAt],
    ['Receipt reference', receipt.reference],
  ]
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#52645c').text(label.toUpperCase())
    doc.font('Helvetica').fontSize(11).fillColor('#253d34').text(String(value), { width: 340 })
    doc.moveDown(0.55)
  }
  doc.moveDown(0.6)
  doc.font('Helvetica').fontSize(8).fillColor('#718078')
    .text('This receipt confirms a payment recorded in the company petty-cash ledger.')
  doc.end()
  return completed
}

module.exports = { createPaymentReceiptPdf }
