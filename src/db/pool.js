const { Pool } = require('pg')

function createPool(databaseConfig) {
  return new Pool({
    ...databaseConfig,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'expense-warrior-api',
  })
}

module.exports = { createPool }
