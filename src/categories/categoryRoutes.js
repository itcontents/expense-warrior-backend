const express = require('express')
const Joi = require('joi')
const { listActiveCategories, listCategoriesWithAccountingMap, setItcAccountingMap } = require('./categoryRepository')
const { createRequireItcSession } = require('../auth/requireItcSession')

const accountingMapSchema = Joi.object({
  itc_expense_category_code: Joi.string().pattern(/^[a-z][a-z0-9_]{1,49}$/).allow(null).required(),
}).unknown(false)

function createCategoryRouter({ pool, identityClient, itcFinanceClient }) {
  const router = express.Router()
  const requireSession = createRequireItcSession(identityClient)

  router.get('/categories', requireSession, async (_req, res) => {
    try {
      const items = await listActiveCategories(pool)
      return res.status(200).json({ data: { items } })
    } catch (_error) {
      return res.status(503).json({
        error: { code: 'CATEGORIES_UNAVAILABLE', message: 'Categories are temporarily unavailable' },
      })
    }
  })

  router.get('/admin/accounting-category-maps', requireSession, async (req, res) => {
    if (String(req.actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    try {
      if (typeof itcFinanceClient?.getExpenseCategories !== 'function') throw new Error('ITC_EXPENSE_CATEGORIES_UNAVAILABLE')
      const [items, itcCategories] = await Promise.all([
        listCategoriesWithAccountingMap(pool),
        itcFinanceClient.getExpenseCategories(req.requestId),
      ])
      return res.status(200).json({ data: { items, itc_categories: itcCategories } })
    } catch (_error) {
      return res.status(503).json({ error: { code: 'ACCOUNTING_CATEGORIES_UNAVAILABLE', message: 'Accounting categories are temporarily unavailable' } })
    }
  })

  router.put('/admin/categories/:category_id/accounting-map', requireSession, async (req, res) => {
    if (String(req.actor.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } })
    }
    const { error: categoryIdError } = Joi.string().guid().validate(req.params.category_id)
    if (categoryIdError) return res.status(400).json({ error: { code: 'INVALID_CATEGORY_ID', message: 'Category ID must be a UUID' } })
    const { value, error } = accountingMapSchema.validate(req.body, { abortEarly: false, convert: false })
    if (error) return res.status(400).json({ error: { code: 'INVALID_ACCOUNTING_CATEGORY_MAP', message: 'Provide an eligible ITC accounting category or null to clear the mapping' } })
    try {
      if (value.itc_expense_category_code !== null) {
        if (typeof itcFinanceClient?.getExpenseCategories !== 'function') throw new Error('ITC_EXPENSE_CATEGORIES_UNAVAILABLE')
        const available = await itcFinanceClient.getExpenseCategories(req.requestId)
        if (!available.some((category) => category.category_code === value.itc_expense_category_code)) {
          return res.status(422).json({ error: { code: 'ITC_EXPENSE_CATEGORY_NOT_POSTABLE', message: 'Select an active ITC operating expense category' } })
        }
      }
      const mapping = await setItcAccountingMap(pool, {
        actorId: req.actor.customerId,
        categoryId: req.params.category_id,
        itcExpenseCategoryCode: value.itc_expense_category_code,
      })
      if (!mapping) return res.status(404).json({ error: { code: 'CATEGORY_NOT_FOUND', message: 'Expense category was not found' } })
      return res.status(200).json({ data: { mapping } })
    } catch (cause) {
      if (cause?.code === 'INVENTORY_CATEGORY_REQUIRES_GRV') {
        return res.status(422).json({ error: { code: cause.code, message: 'Resale stock purchases must use the stock receiving workflow' } })
      }
      return res.status(503).json({ error: { code: 'ACCOUNTING_CATEGORY_MAP_UNAVAILABLE', message: 'The accounting category mapping could not be saved' } })
    }
  })

  return router
}

module.exports = { createCategoryRouter }
