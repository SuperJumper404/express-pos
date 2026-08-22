const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migration = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "20260822140000_stock_inventory.sql"),
  "utf8",
);

assert.match(migration, /CREATE TABLE `stock_items`/);
assert.match(migration, /CREATE TABLE `stock_movements`/);
assert.match(migration, /CREATE TABLE `shopping_list_items`/);
assert.match(migration, /ALTER TABLE `products`[\s\S]*`track_stock`/);
assert.match(migration, /ALTER TABLE `products`[\s\S]*`stock_zero_behavior`/);
assert.match(migration, /ALTER TABLE `products`[\s\S]*`stock_item_id`/);
assert.match(migration, /INSERT INTO `stock_items`[\s\S]*SELECT[\s\S]*'product'/);
assert.match(migration, /COALESCE\(\s*`updated`\s*,\s*`created`\s*\)/);
assert.match(migration, /UPDATE `products` p[\s\S]*p\.`track_stock` = 1/);
assert.match(migration, /DROP TABLE IF EXISTS `shopping_list_items`/);
assert.match(migration, /DROP TABLE IF EXISTS `stock_movements`/);
assert.match(migration, /DROP TABLE IF EXISTS `stock_items`/);

console.log("stock inventory migration tests passed");
