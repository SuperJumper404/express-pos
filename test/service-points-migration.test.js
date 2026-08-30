const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migrationPath = path.join(
  __dirname,
  "../db/migrations/20260812100000_service_points_foundation.sql",
);

assert.ok(
  fs.existsSync(migrationPath),
  "service points foundation migration must exist",
);

const migration = fs.readFileSync(migrationPath, "utf8").replace(/\s+/g, " ");

for (const pattern of [
  /CREATE TABLE `service_points`/,
  /UNIQUE KEY `uq_service_points_shop_system` \(`shopid`, `system_key`\)/,
  /ADD COLUMN `service_point_id` INT\(11\) NULL/,
  /ADD COLUMN `order_source` VARCHAR\(32\) NOT NULL DEFAULT 'pos'/,
  /INSERT IGNORE INTO `service_points`[\s\S]*'counter'/,
  /INSERT IGNORE INTO `service_points`[\s\S]*'click_collect'/,
  /COALESCE\(NULLIF\(CAST\(`created` AS CHAR\), '0000-00-00 00:00:00'\), NOW\(\)\)/,
  /UPDATE `orders`[\s\S]*`service_point_id`/,
  /UPDATE `archives`[\s\S]*`service_point_id`/,
]) {
  assert.match(migration, pattern);
}

console.log("service points migration contract passed");
