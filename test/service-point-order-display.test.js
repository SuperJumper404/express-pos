const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "../src/modules/m_orders.js"),
  "utf8",
);

assert.match(
  source,
  /mAllOrder:[\s\S]*LEFT JOIN service_points[\s\S]*service_point_name/,
);
assert.match(source, /mAllOrder:[\s\S]*stock_reservation_status/);
assert.match(source, /mAllOrder:[\s\S]*GROUP BY order_id/);
assert.doesNotMatch(
  source,
  /mAllOrder:[\s\S]*LEFT JOIN order_stock_reservations\s+ON order_stock_reservations\.order_id = orders\.id/,
);
assert.match(
  source,
  /mAllArchivedOrders:[\s\S]*LEFT JOIN service_points[\s\S]*service_point_name/,
);

console.log("service point order display contract passed");
