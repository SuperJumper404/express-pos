const assert = require("assert");
const fs = require("fs");

const migration = fs.readFileSync(
  require.resolve("../db/migrations/20260922090000_standardize_payment_methods.sql"),
  "utf8",
);

assert.match(migration, /UPDATE `orders`/i);
assert.match(migration, /UPDATE `archives`/i);
assert.match(migration, /payment_provider/i);
assert.match(migration, /used_payment_method/i);
assert.match(migration, /shop_payment_methods/i);
assert.match(migration, /Ticket restaurant/i);
assert.match(migration, /Stripe/i);

console.log("payment method migration tests passed");
