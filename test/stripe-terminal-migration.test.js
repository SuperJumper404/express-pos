const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migration = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "20260926100000_stripe_terminal.sql"),
  "utf8",
);
const [up, down] = migration.split("-- migrate:down");

assert.match(up, /-- migrate:up/);
assert.ok(down, "migration must be reversible");
for (const table of [
  "stripe_terminal_locations",
  "stripe_terminal_readers",
  "stripe_terminal_payments",
  "stripe_terminal_payment_orders",
]) {
  assert.match(up, new RegExp("CREATE TABLE `" + table + "`"));
  assert.match(down, new RegExp("DROP TABLE IF EXISTS `" + table + "`"));
}
assert.match(up, /UNIQUE KEY[^\n]*\(`shopid`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`stripe_location_id`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`stripe_reader_id`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`stripe_payment_intent_id`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`idempotency_key`\)/);
assert.match(up, /`stripe_connected_account_id` varchar\(191\) NOT NULL/);
assert.match(up, /UNIQUE KEY[^\n]*\(`terminal_payment_id`,`order_id`\)/);
const allocations = up.match(/CREATE TABLE `stripe_terminal_payment_orders` \(([\s\S]*?)\) ENGINE=/)[1];
assert.match(allocations, /`refund_generation` int unsigned NOT NULL DEFAULT 0/);
assert.match(allocations, /`stripe_refund_id` varchar\(191\) DEFAULT NULL/);
assert.match(allocations, /`refund_status` varchar\(32\) DEFAULT NULL/);
assert.match(allocations, /UNIQUE KEY[^\n]*\(`stripe_refund_id`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`active_assigned_user_id`\)/);
assert.match(up, /UNIQUE KEY[^\n]*\(`active_assigned_service_point_id`\)/);
assert.match(up, /CHECK \(`assigned_user_id` IS NULL OR `assigned_service_point_id` IS NULL\)/);
for (const table of ["orders", "archives"]) {
  assert.match(up, new RegExp("ALTER TABLE `" + table + "`[\\s\\S]*?ADD COLUMN `stripe_terminal_payment_id`"));
  assert.match(down, new RegExp("ALTER TABLE `" + table + "`[\\s\\S]*?DROP COLUMN `stripe_terminal_payment_id`"));
}

console.log("stripe terminal migration tests passed");
