const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migration = fs.readFileSync(
  path.join(__dirname, "../db/migrations/20260727153000_add_product_vat_snapshots.sql"),
  "utf8",
).replace(/\s+/g, " ");

for (const token of [
  "ALTER TABLE `products` ADD COLUMN `vat_rate` DECIMAL(4,2) NOT NULL DEFAULT 10.00",
  "ADD COLUMN `unit_price_ht` DECIMAL(12,2) NOT NULL DEFAULT 0.00",
  "ADD COLUMN `total_vat` DECIMAL(12,2) NOT NULL DEFAULT 0.00",
  "UPDATE `orderdetail`",
  "UPDATE `archivesdetail`",
  "ROUND(`total` / 1.10, 2)",
]) {
  assert.ok(migration.includes(token), token);
}

console.log("vat migration contract passed");
