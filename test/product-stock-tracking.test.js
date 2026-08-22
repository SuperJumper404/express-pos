const assert = require("assert");
const fs = require("fs");
const path = require("path");

const checkoutSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_checkout.js"),
  "utf8",
);
const productsControllerSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "controllers", "c_products.js"),
  "utf8",
);

assert.match(checkoutSource, /SELECT id, shopid, stock, track_stock/);
assert.match(checkoutSource, /linked_product\.track_stock AS linked_product_track_stock/);
assert.match(productsControllerSource, /track_stock/);
assert.match(productsControllerSource, /stock_zero_behavior/);

console.log("product stock tracking tests passed");
