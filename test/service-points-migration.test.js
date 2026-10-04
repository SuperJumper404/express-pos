const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migrationPath = path.join(
  __dirname,
  "../db/migrations/20260812100000_service_points_foundation.sql",
);
const kioskPrinterMigrationPath = path.join(
  __dirname,
  "../db/migrations/20261004120000_add_kiosk_printer_settings.sql",
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

assert.ok(
  fs.existsSync(kioskPrinterMigrationPath),
  "kiosk printer settings migration must exist",
);

const kioskPrinterMigration = fs
  .readFileSync(kioskPrinterMigrationPath, "utf8")
  .replace(/\s+/g, " ");

for (const pattern of [
  /ALTER TABLE `service_points`/,
  /ADD COLUMN `printer_ip` varchar\(255\) NOT NULL DEFAULT ''/,
  /ADD COLUMN `smart_print_app` tinyint\(1\) NOT NULL DEFAULT '0'/,
  /DROP COLUMN `smart_print_app`/,
  /DROP COLUMN `printer_ip`/,
]) {
  assert.match(kioskPrinterMigration, pattern);
}

console.log("service points migration contract passed");
