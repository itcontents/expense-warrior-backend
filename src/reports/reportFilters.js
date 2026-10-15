const TIME_ZONE = 'Africa/Lusaka'

class ReportFilterError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ReportFilterError'
    this.code = code
    this.statusCode = 400
  }
}

function localDateAt(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReportFilterError('INVALID_REPORT_DATE')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ReportFilterError('INVALID_REPORT_DATE')
  return date
}

function addDays(value, days) {
  const date = parseDate(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function monthStart(value) { return `${value.slice(0, 7)}-01` }
function nextMonth(value) {
  const date = parseDate(`${value.slice(0, 7)}-01`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.toISOString().slice(0, 10)
}
function startAtLusakaMidnight(value) {
  return new Date(`${value}T00:00:00.000+02:00`).toISOString()
}

function resolveReportWindow({ preset, from, to, now = new Date() }) {
  let fromDate
  let toDate
  const today = localDateAt(now)
  if (preset === 'today') fromDate = toDate = today
  else if (preset === 'yesterday') fromDate = toDate = addDays(today, -1)
  else if (preset === 'this_month') { fromDate = monthStart(today); toDate = today }
  else if (preset === 'last_month') { toDate = addDays(monthStart(today), -1); fromDate = monthStart(toDate) }
  else if (preset === 'custom') { parseDate(from); parseDate(to); fromDate = from; toDate = to }
  else throw new ReportFilterError('INVALID_REPORT_RANGE')

  parseDate(fromDate)
  parseDate(toDate)
  if (toDate < fromDate) throw new ReportFilterError('INVALID_REPORT_DATE_RANGE')
  return {
    fromDate,
    toDate,
    start: startAtLusakaMidnight(fromDate),
    end: startAtLusakaMidnight(addDays(toDate, 1)),
    timeZone: TIME_ZONE,
  }
}

module.exports = { resolveReportWindow, ReportFilterError, TIME_ZONE }
