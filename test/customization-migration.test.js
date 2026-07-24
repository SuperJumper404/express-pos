const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sql = fs.readFileSync(
  path.join(
    __dirname,
    "../db/migrations/20260724120000_customization_steps_v2.sql",
  ),
  "utf8",
);

for (const token of [
  "CREATE TABLE `customization_steps`",
  "CREATE TABLE `customization_step_choices`",
  "CREATE TABLE `product_customization_steps`",
  "CREATE TABLE `product_customization_step_choices`",
  "CREATE TABLE `orderdetail_customization_snapshots`",
  "CREATE TABLE `archivesdetail_customization_snapshots`",
  "CREATE TABLE `order_stock_reservations`",
  "client_order_token",
  "client_order_payload_hash",
  "FROM product_customization",
  "FROM product_choice",
]) {
  assert.ok(sql.includes(token), token);
}

console.log("customization migration contract passed");

const verifier = fs.readFileSync(
  path.join(__dirname, "../scripts/verify-customization-v2.js"),
  "utf8",
);
for (const token of [
  "FROM product_customization",
  "FROM customization_steps",
  "FROM product_choice",
  "FROM customization_step_choices",
  "FROM product_customization_steps",
  "FROM product_customization_step_choices",
  "FROM orders_customization",
  "FROM orderdetail_customization_snapshots",
]) {
  assert.ok(verifier.includes(token), token);
}
assert.ok(verifier.includes("Unresolved archive selections"));
assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|REPLACE)\b/i.test(
  verifier.replace(/console\.(?:log|error)\([^;]+;/g, ""),
));

const packageJson = require("../package.json");
assert.ok(packageJson.scripts.test.includes("customization-migration.test.js"));
assert.strictEqual(
  packageJson.scripts["db:verify:customization:v2"],
  "cross-env ENV_FILE=.env.local node scripts/verify-customization-v2.js",
);

console.log("customization verifier contract passed");
