const assert = require("assert");
const {
  toNonNegativeInteger,
  toPositiveInteger,
  resolveStockStatus,
  buildShoppingListItem,
  calculateAverageUnitPrice,
  isStockTrackedProduct,
} = require("../src/helpers/stockInventory");

assert.strictEqual(toNonNegativeInteger("0", "stock"), 0);
assert.strictEqual(toNonNegativeInteger(4, "stock"), 4);
assert.throws(() => toNonNegativeInteger(-1, "stock"), /stock must be a non-negative integer/);
assert.throws(() => toNonNegativeInteger(1.5, "stock"), /stock must be a non-negative integer/);

assert.strictEqual(toPositiveInteger("3", "quantity"), 3);
assert.throws(() => toPositiveInteger(0, "quantity"), /quantity must be a positive integer/);

assert.strictEqual(resolveStockStatus({ current_stock: 2, minimum_stock: 6, target_stock: 20 }), "red");
assert.strictEqual(resolveStockStatus({ current_stock: 12, minimum_stock: 6, target_stock: 20 }), "orange");
assert.strictEqual(resolveStockStatus({ current_stock: 20, minimum_stock: 6, target_stock: 20 }), "normal");

assert.deepStrictEqual(buildShoppingListItem({
  id: 7,
  current_stock: 2,
  minimum_stock: 6,
  target_stock: 20,
  average_unit_price: 7.5,
}), {
  stock_item_id: 7,
  status_at_generation: "red",
  current_stock_at_generation: 2,
  target_stock_at_generation: 20,
  quantity_to_buy: 18,
  estimated_unit_price: 7.5,
  estimated_total_price: 135,
  taken: 0,
});
assert.strictEqual(buildShoppingListItem({
  id: 8,
  current_stock: 20,
  minimum_stock: 6,
  target_stock: 20,
}), null);

assert.strictEqual(calculateAverageUnitPrice([
  { quantity: 20, total_price: 140 },
  { quantity: 10, total_price: 80 },
]), 7.33);
assert.strictEqual(calculateAverageUnitPrice([]), null);

assert.strictEqual(isStockTrackedProduct({ track_stock: 1 }), true);
assert.strictEqual(isStockTrackedProduct({ track_stock: true }), true);
assert.strictEqual(isStockTrackedProduct({ track_stock: 0 }), false);

console.log("stock inventory domain tests passed");
