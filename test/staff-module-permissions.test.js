const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "src", "helpers", "staffPermissions.js");
const migrationPath = path.join(
  root,
  "db",
  "migrations",
  "20260811140000_staff_module_permissions.sql",
);

assert.strictEqual(
  fs.existsSync(helperPath),
  true,
  "staff module permission helper must exist",
);
assert.strictEqual(
  fs.existsSync(migrationPath),
  true,
  "staff module permission migration must exist",
);

const {
  ACCESS,
  STAFF_MODULE_KEYS,
  getDefaultModulePermissions,
  normalizeModulePermissions,
} = require(helperPath);

assert.deepStrictEqual(
  STAFF_MODULE_KEYS,
  [
    "home",
    "orders",
    "cashregister",
    "history",
    "catalog",
    "stocks",
    "tables",
    "reports",
    "website",
    "borne",
  ],
);
assert.deepStrictEqual(getDefaultModulePermissions(ACCESS.CASHIER), [
  "orders",
  "cashregister",
  "history",
]);
assert.deepStrictEqual(getDefaultModulePermissions(ACCESS.SERVER), ["orders"]);
assert.deepStrictEqual(normalizeModulePermissions(["orders", "invalid", "orders"]), [
  "orders",
]);
assert.deepStrictEqual(normalizeModulePermissions(null, ACCESS.KITCHEN), [
  "orders",
]);

const migration = fs.readFileSync(migrationPath, "utf8");
assert.match(migration, /module_permissions TEXT NULL/);

console.log("staff module permission tests passed");
