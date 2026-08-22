const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_stockInventory.js"),
  "utf8",
);

assert.match(source, /LEFT JOIN products p ON p\.id = si\.product_id/);
assert.match(source, /p\.track_stock/);
assert.match(source, /p\.stock_zero_behavior/);
assert.match(source, /COALESCE\(p\.stock, si\.current_stock\) AS current_stock/);
assert.match(source, /si\.archived = 0/);
assert.match(source, /p\.archived = 0/);
assert.match(source, /p\.track_stock = 1/);
assert.match(source, /const listLowItems/);
assert.match(source, /const bulkInventory/);
assert.match(source, /const archiveIngredient/);
assert.match(source, /const deleteIngredient/);

console.log("stock inventory module tests passed");
