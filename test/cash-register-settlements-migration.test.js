const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migrationPath = path.join(
  __dirname,
  "..",
  "db",
  "migrations",
  "20260927100000_cash_register_settlements.sql",
);

assert.ok(fs.existsSync(migrationPath), "cash register settlements migration must exist");

const migration = fs.readFileSync(migrationPath, "utf8");
const [up, down] = migration.split("-- migrate:down");

assert.match(up, /-- migrate:up/);
assert.ok(down, "migration must be reversible");
assert.match(up, /CREATE TABLE `cash_register_settlements`/);

const settlements = up.match(
  /CREATE TABLE `cash_register_settlements` \(([\s\S]*?)\) ENGINE=/,
)[1];

for (const pattern of [
  /`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/i,
  /`shopid` INT\(11\) NOT NULL/i,
  /`service_point_id` INT\(11\) DEFAULT NULL/i,
  /`table_reference` VARCHAR\(191\) NOT NULL/i,
  /`payment_method` VARCHAR\(64\) NOT NULL/i,
  /`subtotal_before_discount` DECIMAL\(10,2\) NOT NULL/i,
  /`discount_type` VARCHAR\(16\) NOT NULL/i,
  /`discount_value` DECIMAL\(10,2\) NOT NULL/i,
  /`discount_amount` DECIMAL\(10,2\) NOT NULL/i,
  /`total_amount` DECIMAL\(10,2\) NOT NULL/i,
  /`stripe_terminal_payment_id` INT DEFAULT NULL/i,
  /`idempotency_key` VARCHAR\(191\) NOT NULL/i,
  /`created_by_user_id` INT\(11\) DEFAULT NULL/i,
  /`created_at` DATETIME\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(6\)/i,
  /`updated_at` DATETIME\(6\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(6\) ON UPDATE CURRENT_TIMESTAMP\(6\)/i,
  /UNIQUE KEY `uq_cash_register_settlements_shop_idempotency` \(`shopid`, `idempotency_key`\)/i,
  /KEY `idx_cash_register_settlements_shop_created_at` \(`shopid`, `created_at`\)/i,
]) {
  assert.match(settlements, pattern);
}

assert.match(
  up,
  /ALTER TABLE `archives`[\s\S]*ADD COLUMN `cash_register_settlement_id` BIGINT UNSIGNED NULL[\s\S]*ADD KEY `idx_archives_cash_register_settlement` \(`cash_register_settlement_id`\)[\s\S]*ADD CONSTRAINT `fk_archives_cash_register_settlement`\s+FOREIGN KEY \(`cash_register_settlement_id`\)\s+REFERENCES `cash_register_settlements` \(`id`\)/i,
);

const dropForeignKeyAt = down.indexOf(
  "DROP FOREIGN KEY `fk_archives_cash_register_settlement`",
);
const dropTableAt = down.indexOf("DROP TABLE IF EXISTS `cash_register_settlements`");

assert.ok(dropForeignKeyAt >= 0, "down migration must remove the archive foreign key");
assert.ok(dropTableAt >= 0, "down migration must drop the settlements table");
assert.ok(
  dropForeignKeyAt < dropTableAt,
  "down migration must remove the archive foreign key before dropping the settlements table",
);
assert.match(
  down,
  /ALTER TABLE `archives`[\s\S]*DROP KEY `idx_archives_cash_register_settlement`[\s\S]*DROP COLUMN `cash_register_settlement_id`/i,
);

console.log("cash register settlements migration contract passed");
