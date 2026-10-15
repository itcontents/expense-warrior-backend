async function listActiveCategories(pool) {
  const result = await pool.query(`
    SELECT category_id,
           parent_category_id,
           code,
           name,
           reason_required,
           attachment_required
      FROM expense_categories
     WHERE is_active = true
     ORDER BY COALESCE(parent_category_id, category_id),
              (parent_category_id IS NOT NULL),
              code,
              category_id
  `)
  return result.rows
}

async function listCategoriesWithAccountingMap(pool) {
  const result = await pool.query(`
    SELECT category_id,
           parent_category_id,
           code,
           name,
           is_active,
           itc_expense_category_code,
           updated_at
      FROM expense_categories
     ORDER BY COALESCE(parent_category_id, category_id),
              (parent_category_id IS NOT NULL),
              code,
              category_id
  `)
  return result.rows
}

async function setItcAccountingMap(pool, { actorId, categoryId, itcExpenseCategoryCode }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(`
      SELECT category.category_id, category.code, category.parent_category_id,
             category.itc_expense_category_code, parent.code AS parent_code
        FROM expense_categories category
        LEFT JOIN expense_categories parent ON parent.category_id = category.parent_category_id
       WHERE category.category_id = $1
       FOR UPDATE
    `, [categoryId])
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('COMMIT')
      return null
    }
    if (current.code === 'STOCK_PURCHASING' || current.parent_code === 'STOCK_PURCHASING') {
      const error = new Error('INVENTORY_CATEGORY_REQUIRES_GRV')
      error.code = 'INVENTORY_CATEGORY_REQUIRES_GRV'
      error.statusCode = 422
      throw error
    }
    if (current.itc_expense_category_code === itcExpenseCategoryCode) {
      await client.query('COMMIT')
      return current
    }
    const updatedResult = await client.query(`
      UPDATE expense_categories
         SET itc_expense_category_code = $2,
             updated_at = transaction_timestamp()
       WHERE category_id = $1
       RETURNING category_id, code, parent_category_id, itc_expense_category_code, updated_at
    `, [categoryId, itcExpenseCategoryCode])
    const updated = updatedResult.rows[0]
    await client.query(`
      INSERT INTO audit_events (actor_customer_id, action, target_type, target_id, metadata)
      VALUES ($1, 'expense_category.accounting_map_changed', 'expense_category', $2, $3::jsonb)
    `, [actorId, categoryId, JSON.stringify({
      category_code: current.code,
      previous_itc_expense_category_code: current.itc_expense_category_code || null,
      itc_expense_category_code: itcExpenseCategoryCode,
    })])
    await client.query('COMMIT')
    return updated
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

module.exports = { listActiveCategories, listCategoriesWithAccountingMap, setItcAccountingMap }
