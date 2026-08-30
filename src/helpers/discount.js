const { parseMoney } = require('./money')

const DEFAULT_DISCOUNT_PERCENTAGES = [5, 10, 15, 20]

const roundMoney = (value) => Number(Number(value).toFixed(2))

const normalizeDiscountPercentages = (values) => {
  const source = Array.isArray(values) ? values : []
  const normalized = source
    .map((value) => parseMoney(value))
    .filter((value) => value !== null && value > 0 && value <= 100)
  const unique = [...new Set(normalized)].sort((left, right) => left - right)
  return unique.length ? unique : [...DEFAULT_DISCOUNT_PERCENTAGES]
}

const calculateDiscount = ({ subtotal, type, value }) => {
  const base = parseMoney(subtotal)
  const normalizedType = ['percent', 'amount'].includes(type) ? type : 'none'
  const normalizedValue = Math.max(0, parseMoney(value) || 0)
  const amount = normalizedType === 'percent'
    ? roundMoney((base || 0) * Math.min(normalizedValue, 100) / 100)
    : normalizedType === 'amount' ? Math.min(base || 0, normalizedValue) : 0

  return {
    type: normalizedType,
    value: normalizedValue,
    amount: roundMoney(amount),
    total: roundMoney((base || 0) - amount),
  }
}

module.exports = {
  DEFAULT_DISCOUNT_PERCENTAGES,
  calculateDiscount,
  normalizeDiscountPercentages,
}
