const assert = require('node:assert/strict')
const test = require('node:test')
const { createCookieCsrfGuard } = require('../src/auth/cookieCsrfGuard')

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('Expense Warrior cookie mutations require an allowed browser origin', () => {
  const guard = createCookieCsrfGuard({ allowedOrigins: ['https://expense-warrior.example'], nodeEnv: 'production' })
  const res = response()
  let nextCalled = false

  guard({ method: 'POST', headers: { cookie: 'itc_expense_warrior_access=session' } }, res, () => { nextCalled = true })

  assert.equal(res.statusCode, 403)
  assert.equal(nextCalled, false)
})

test('Expense Warrior cookie mutations accept the configured app origin', () => {
  const guard = createCookieCsrfGuard({ allowedOrigins: ['https://expense-warrior.example'], nodeEnv: 'production' })
  const res = response()
  let nextCalled = false

  guard({ method: 'PATCH', headers: {
    cookie: 'itc_expense_warrior_access=session',
    origin: 'https://expense-warrior.example',
  } }, res, () => { nextCalled = true })

  assert.equal(res.statusCode, null)
  assert.equal(nextCalled, true)
})
