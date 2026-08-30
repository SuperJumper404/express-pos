const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migration = fs.readFileSync(
  path.join(__dirname, "../db/migrations/20260727153000_add_product_vat_snapshots.sql"),
  "utf8",
).replace(/\s+/g, " ");

const productTakeawayVatMigration = fs.existsSync(
  path.join(__dirname, "../db/migrations/20260812130000_product_takeaway_vat.sql"),
)
  ? fs.readFileSync(
    path.join(__dirname, "../db/migrations/20260812130000_product_takeaway_vat.sql"),
    "utf8",
  ).replace(/\s+/g, " ")
  : "";

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

for (const token of [
  "ADD COLUMN `vat_rate_dine_in` DECIMAL(4,2) NOT NULL DEFAULT 10.00",
  "ADD COLUMN `vat_rate_takeaway` DECIMAL(4,2) NOT NULL DEFAULT 10.00",
  "`vat_rate_dine_in` = `vat_rate`",
  "`vat_rate_takeaway` = `vat_rate`",
]) {
  assert.ok(productTakeawayVatMigration.includes(token), token);
}

console.log("vat migration contract passed");
