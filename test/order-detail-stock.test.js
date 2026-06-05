const assert = require("assert");
const { buildOrderDetailStockEntry } = require("../src/helpers/orderDetailStock");

const entry = buildOrderDetailStockEntry({
  productid: 12,
  qty: 3,
  operator: 7,
});

assert.strictEqual(entry.productid, 12);
assert.strictEqual(entry.category, "1");
assert.strictEqual(entry.qty, 3);
assert.strictEqual(entry.operator, 7);
assert.strictEqual(entry.remark, "Transaction");
assert.match(entry.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
assert.strictEqual(entry.updated, entry.created);

console.log("order detail stock tests passed");
