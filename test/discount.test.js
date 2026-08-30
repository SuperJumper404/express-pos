const assert = require('assert')
const {
  DEFAULT_DISCOUNT_PERCENTAGES,
  calculateDiscount,
  normalizeDiscountPercentages,
} = require('../src/helpers/discount')

assert.deepStrictEqual(
  normalizeDiscountPercentages(['10', 5, 10, 0, 101, 'abc']),
  [5, 10]
)
assert.deepStrictEqual(
  normalizeDiscountPercentages([]),
  DEFAULT_DISCOUNT_PERCENTAGES
)
assert.deepStrictEqual(
  calculateDiscount({ subtotal: 30, type: 'percent', value: 10 }),
  { type: 'percent', value: 10, amount: 3, total: 27 }
)
assert.deepStrictEqual(
  calculateDiscount({ subtotal: 30, type: 'amount', value: 5 }),
  { type: 'amount', value: 5, amount: 5, total: 25 }
)
assert.deepStrictEqual(
  calculateDiscount({ subtotal: 3, type: 'amount', value: 5 }),
  { type: 'amount', value: 5, amount: 3, total: 0 }
)

console.log('discount tests passed')
