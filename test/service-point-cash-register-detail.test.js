const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const controller = fs.readFileSync(
  path.join(root, "src/controllers/c_orders.js"),
  "utf8",
);
const moduleSource = fs.readFileSync(
  path.join(root, "src/modules/m_orders.js"),
  "utf8",
);

assert.match(controller, /req\.query\.servicePointId \|\| req\.query\.userId/);
assert.match(controller, /mOrdersbyUserId\(servicePointId, req\.shopid\)/);
assert.match(moduleSource, /orders\.service_point_id = \?/);
assert.match(moduleSource, /orders\.service_point_id IS NULL AND orders\.customerID = \?/);
assert.match(moduleSource, /WHERE orders\.shopid = \?/);

console.log("service point cash register detail contract passed");
